import { describe, expect, it } from 'vitest';
import { manualSecret, qrModules } from './totp-qr';

const URI = 'otpauth://totp/Pepper:ana%40example.test?secret=JBSWY3DPEHPK3PXP&issuer=Pepper';

describe('qrModules', () => {
  it('encodes the URI as a square grid with a quiet border', () => {
    const { size, dark } = qrModules(URI);
    expect(size).toBeGreaterThanOrEqual(25);
    expect(dark.length).toBeGreaterThan(100);
    for (const [x, y] of dark) {
      expect(x).toBeGreaterThanOrEqual(2);
      expect(y).toBeLessThan(size - 2);
    }
  });
});

describe('manualSecret', () => {
  it('groups the secret in fours', () => {
    expect(manualSecret(URI)).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('is null without a secret', () => {
    expect(manualSecret('otpauth://totp/x')).toBeNull();
    expect(manualSecret('not a uri')).toBeNull();
  });
});
