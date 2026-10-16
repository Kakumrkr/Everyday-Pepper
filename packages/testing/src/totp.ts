import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * The RFC 6238 TOTP code (HMAC-SHA1) for a base32 secret at `time`, as an authenticator app
 * shows it. Tests use it to complete two-factor sign-in.
 */
export function totpCode(
  secret: string,
  options: { time?: Date; digits?: number; period?: number } = {},
): string {
  const { time = new Date(), digits = 6, period = 30 } = options;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time.getTime() / 1000 / period)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- SHA-1 digests are 20 bytes
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The code for an `otpauth://totp/...` URI (what the MFA setup QR code encodes). */
export function totpCodeFromUri(uri: string, time?: Date): string {
  const url = new URL(uri);
  const secret = url.searchParams.get('secret');
  if (url.protocol !== 'otpauth:' || secret === null) throw new Error('Not a TOTP URI');
  const digits = Number(url.searchParams.get('digits') ?? 6);
  const period = Number(url.searchParams.get('period') ?? 30);
  return totpCode(secret, { digits, period, ...(time && { time }) });
}
