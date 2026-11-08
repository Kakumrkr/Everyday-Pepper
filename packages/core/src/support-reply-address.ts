import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

// Signed reply addresses of support requests (S59.3, ADR-0063, AC-X-32): one address a
// request, `reply+pep-7k2m9q-1-<mac>@<inbound domain>`, and the same token in the request's
// root id (`<support.<token>@<domain>>`) for `In-Reply-To`/`References`. The address names the
// request, not a person (who may write is the sender check's); its signature is checked before
// anything is looked up. Lowercase base32 only: mail servers may change an address's case.

/** The signing keys by version; `current` signs, every version present still reads. */
export interface SupportReplyKeys {
  current: number;
  keys: ReadonlyMap<number, Buffer>;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const MAC_CHARS = 20;
const REFERENCE = /^PEP-[0-9A-HJKMNP-TV-Z]{6}$/;
const TOKEN = /^(pep-[0-9a-hjkmnp-tv-z]{6})-([1-9][0-9]?)-([a-z2-7]{20})$/;
const VERSIONS = [1] as const;

/** The reply addresses' keys, from the outbox key (`outboxKeyFrom(OUTBOX_SECRET)`). */
export function supportReplyKeysFrom(outboxKey: Buffer): SupportReplyKeys {
  const keys = new Map<number, Buffer>();
  for (const version of VERSIONS) {
    keys.set(
      version,
      Buffer.from(
        hkdfSync('sha256', outboxKey, '', `pepper/support-reply-addresses/v${String(version)}`, 32),
      ),
    );
  }
  return { current: Math.max(...VERSIONS), keys };
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return out;
}

function mac(key: Buffer, version: number, reference: string): string {
  const digest = createHmac('sha256', key)
    .update(`${String(version)}:${reference.toUpperCase()}`)
    .digest();
  return base32(digest).slice(0, MAC_CHARS);
}

/** The request's token, e.g. `pep-7k2m9q-1-abcdefghijklmnopqrst`. */
export function supportReplyToken(keys: SupportReplyKeys, reference: string): string {
  if (!REFERENCE.test(reference)) throw new RangeError('Not a support reference');
  const key = keys.keys.get(keys.current);
  if (key === undefined) throw new RangeError('No current reply-address key');
  return `${reference.toLowerCase()}-${String(keys.current)}-${mac(key, keys.current, reference)}`;
}

/** The request's reply address on `domain`. */
export function supportReplyAddress(
  keys: SupportReplyKeys,
  reference: string,
  domain: string,
): string {
  return `reply+${supportReplyToken(keys, reference)}@${domain.toLowerCase()}`;
}

/** The request's root id, for `In-Reply-To` and `References` (angle brackets included). */
export function supportThreadRootId(
  keys: SupportReplyKeys,
  reference: string,
  domain: string,
): string {
  return `<support.${supportReplyToken(keys, reference)}@${domain.toLowerCase()}>`;
}

/** The reference a token names (`PEP-…`), or `null` for one these keys did not sign. */
export function readSupportReplyToken(keys: SupportReplyKeys, token: string): string | null {
  const match = TOKEN.exec(token.toLowerCase());
  if (match === null) return null;
  const [, lower, versionText, given] = match;
  if (lower === undefined || versionText === undefined || given === undefined) return null;
  const version = Number(versionText);
  const key = keys.keys.get(version);
  if (key === undefined) return null;
  const reference = lower.toUpperCase();
  const expected = mac(key, version, reference);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return null;
  return reference;
}

/**
 * The request an inbound email names, by its signed address among the recipients first, then
 * by the root id in `In-Reply-To`/`References` (a mail app that answered `From`). Only
 * addresses and ids on `domain` count; `null` when none carries a valid signature.
 */
export function findSupportReference(
  keys: SupportReplyKeys,
  domain: string,
  email: { recipients: readonly string[]; inReplyTo: string | null; references: readonly string[] },
): string | null {
  const host = domain.toLowerCase();
  for (const address of email.recipients) {
    const match = /^reply\+([^@\s]+)@([^@\s]+)$/.exec(address.trim().toLowerCase());
    if (match?.[2] !== host || match[1] === undefined) continue;
    const reference = readSupportReplyToken(keys, match[1]);
    if (reference !== null) return reference;
  }
  const ids = [...(email.inReplyTo === null ? [] : [email.inReplyTo]), ...email.references];
  for (const id of ids) {
    const match = /^<?support\.([^@\s>]+)@([^@\s>]+)>?$/.exec(id.trim().toLowerCase());
    if (match?.[2] !== host || match[1] === undefined) continue;
    const reference = readSupportReplyToken(keys, match[1]);
    if (reference !== null) return reference;
  }
  return null;
}
