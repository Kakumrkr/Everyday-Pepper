import { createHmac, timingSafeEqual } from 'node:crypto';

// Twilio's webhook signatures (S61, ADR-0065 §5, AC-X-61): `X-Twilio-Signature` is the base64
// HMAC-SHA1, keyed with the account's auth token, of the full URL Twilio called (query included)
// followed by every form field's name and value, sorted by name (then value). Twilio's requests
// carry no timestamp, so a replay is caught by the provider's message id instead.

/** The signature Twilio sends for `url` and the form `fields`. */
export function twilioSignatureOf(
  authToken: string,
  url: string,
  fields: readonly (readonly [string, string])[],
): string {
  const sorted = [...fields].sort(([a, x], [b, y]) =>
    a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1,
  );
  const data = url + sorted.map(([name, value]) => name + value).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** Whether `signature` is Twilio's for `url` and `fields`, compared in constant time. */
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  fields: readonly (readonly [string, string])[],
  signature: string | undefined,
): boolean {
  if (signature === undefined || signature.length === 0 || signature.length > 200) return false;
  const expected = Buffer.from(twilioSignatureOf(authToken, url, fields), 'base64');
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
