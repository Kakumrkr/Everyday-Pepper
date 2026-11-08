import { createHmac, timingSafeEqual } from 'node:crypto';

// Svix webhook signatures (Resend's webhooks, S59.3, ADR-0063 §3): HMAC-SHA256 of
// `<svix-id>.<svix-timestamp>.<raw body>` with the secret's bytes (`whsec_` + base64), sent as
// one or more space-separated `v1,<base64>` in `svix-signature`. The timestamp must be within
// `toleranceSeconds` of now, so a captured request can't be replayed later.

export interface SvixHeaders {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
}

/** The secret's key bytes, or `null` for a value that is not a `whsec_` secret. */
export function svixKeyOf(secret: string): Buffer | null {
  const match = /^whsec_([A-Za-z0-9+/]+={0,2})$/.exec(secret.trim());
  if (match?.[1] === undefined) return null;
  const key = Buffer.from(match[1], 'base64');
  return key.length >= 16 ? key : null;
}

/** Whether `body` was signed with `key` for these headers, within the time window. */
export function verifySvix(
  key: Buffer,
  headers: SvixHeaders,
  body: Buffer,
  now: Date,
  toleranceSeconds = 300,
): boolean {
  const { id, timestamp, signature } = headers;
  if (id === undefined || timestamp === undefined || signature === undefined) return false;
  if (id.length === 0 || id.length > 200 || signature.length > 2000) return false;
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  const sentAt = Number(timestamp);
  if (Math.abs(now.getTime() / 1000 - sentAt) > toleranceSeconds) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || value === undefined) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}
