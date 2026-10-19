import { describe, expect, it } from 'vitest';
import { totpCode, totpCodeFromUri } from './totp.js';

// RFC 6238 appendix B: SHA-1 secret "12345678901234567890", 8 digits.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [20000000000, '65353130'],
  ])('matches the RFC 6238 vector at %i s', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, { time: new Date(seconds * 1000), digits: 8 })).toBe(expected);
  });

  it('defaults to 6 digits', () => {
    expect(totpCode(RFC_SECRET, { time: new Date(59_000) })).toBe('287082');
  });

  it('rejects a secret that is not base32', () => {
    expect(() => totpCode('not base32!')).toThrow('Invalid base32 secret');
  });
});

describe('totpCodeFromUri', () => {
  it('reads the secret, digits and period from the URI', () => {
    const uri = `otpauth://totp/Pepper:ana%40example.test?secret=${RFC_SECRET}&issuer=Pepper&digits=8&period=30`;
    expect(totpCodeFromUri(uri, new Date(59_000))).toBe('94287082');
    expect(totpCodeFromUri(uri.replace('&digits=8', ''), new Date(59_000))).toBe('287082');
  });

  it('rejects other URIs', () => {
    expect(() => totpCodeFromUri('https://example.test/?secret=AAAA')).toThrow('Not a TOTP URI');
    expect(() => totpCodeFromUri('otpauth://totp/x')).toThrow('Not a TOTP URI');
  });
});
