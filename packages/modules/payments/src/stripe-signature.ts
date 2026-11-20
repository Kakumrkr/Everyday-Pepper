import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe's webhook signature (S65, ADR-0067 §6.1, AC-X-98). `Stripe-Signature` is a list of
// `key=value` pairs separated by commas, in any order: `t` (seconds since the epoch) and one or
// more `v1` (hex HMAC-SHA256 of `"<t>.<raw body>"`, keyed with the endpoint's whole `whsec_…`
// secret). While a secret is rolled Stripe signs with both, so any `v1` may match. `v0` and the
// unsigned debug entries (`secret`, `destination`, `payload`) are never used. The timestamp must
// be within `toleranceSeconds` of now either way, so a captured delivery can't be replayed later.

/** Stripe's default, and ours. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Longer than any real header (a few signatures); a longer one is refused unread. */
const HEADER_MAX = 4096;
const TIMESTAMP = /^\d{1,12}$/;
const V1 = /^[0-9a-f]{64}$/;

/** The hex signature Stripe computes for `payload` sent at `timestamp`. */
export function stripeSignature(
  secret: string,
  timestamp: number,
  payload: Buffer | string,
): string {
  return createHmac('sha256', secret)
    .update(`${String(timestamp)}.`, 'utf8')
    .update(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
    .digest('hex');
}

/** A `Stripe-Signature` header for `payload` (the sandbox's deliveries and tests). */
export function stripeSignatureHeader(secret: string, payload: Buffer | string, now: Date): string {
  const timestamp = Math.floor(now.getTime() / 1000);
  return `t=${String(timestamp)},v1=${stripeSignature(secret, timestamp, payload)}`;
}

export interface StripeSignatureCheck {
  secret: string;
  /** The request's exact bytes, before any parsing. */
  payload: Buffer;
  header: string | undefined;
  now: Date;
  toleranceSeconds?: number;
}

/** Whether `header` signs `payload` with `secret`, recently enough. Constant time per signature. */
export function verifyStripeSignature(check: StripeSignatureCheck): boolean {
  const { header } = check;
  if (header === undefined || header.length === 0 || header.length > HEADER_MAX) return false;
  const timestamps: string[] = [];
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') timestamps.push(value);
    else if (key === 'v1') signatures.push(value);
  }
  // One timestamp, or the header is not Stripe's.
  const [timestamp] = timestamps;
  if (timestamps.length !== 1 || timestamp === undefined || !TIMESTAMP.test(timestamp)) {
    return false;
  }
  const sentAt = Number(timestamp);
  const tolerance = check.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(check.now.getTime() / 1000 - sentAt) > tolerance) return false;
  const expected = Buffer.from(stripeSignature(check.secret, sentAt, check.payload), 'hex');
  let matched = false;
  // Every candidate is compared, so the time taken doesn't say which one matched.
  for (const signature of signatures) {
    if (!V1.test(signature)) continue;
    if (timingSafeEqual(Buffer.from(signature, 'hex'), expected)) matched = true;
  }
  return matched;
}
