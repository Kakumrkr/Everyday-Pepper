import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  calendarTokenKeyFrom,
  codeChallengeOf,
  openToken,
  randomToken,
  SealedTokenError,
  sealToken,
  stateHashOf,
} from './tokens.js';

// Sealed tokens (AC-X-153): only the same key, row and purpose open them.

const key = calendarTokenKeyFrom(randomBytes(32));
const ROW = '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11';

describe('sealed tokens', () => {
  it('open with the same key, row and purpose', () => {
    const sealed = sealToken(key, ROW, 'refresh', '1//0g-refresh');
    expect(sealed.includes(Buffer.from('1//0g-refresh'))).toBe(false);
    expect(openToken(key, ROW, 'refresh', sealed)).toBe('1//0g-refresh');
  });

  it.each([
    [
      'another row',
      () =>
        openToken(
          key,
          '1b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11',
          'refresh',
          sealToken(key, ROW, 'refresh', 't'),
        ),
    ],
    ['another purpose', () => openToken(key, ROW, 'access', sealToken(key, ROW, 'refresh', 't'))],
    [
      'another key',
      () =>
        openToken(
          calendarTokenKeyFrom(randomBytes(32)),
          ROW,
          'refresh',
          sealToken(key, ROW, 'refresh', 't'),
        ),
    ],
    [
      'a changed byte',
      () => {
        const sealed = sealToken(key, ROW, 'refresh', 'token');
        sealed[sealed.length - 1] = (sealed[sealed.length - 1] ?? 0) ^ 1;
        return openToken(key, ROW, 'refresh', sealed);
      },
    ],
    ['a short value', () => openToken(key, ROW, 'refresh', Buffer.from([1, 2, 3]))],
  ])('do not open for %s', (_, open) => {
    expect(open).toThrow(SealedTokenError);
  });

  it('use a key of their own, not the outbox key', () => {
    const outbox = randomBytes(32);
    expect(calendarTokenKeyFrom(outbox).equals(outbox)).toBe(false);
    expect(() => calendarTokenKeyFrom(randomBytes(16))).toThrow(RangeError);
  });
});

describe('connect states', () => {
  it('are 43 base64url characters, stored as a 32-byte hash', () => {
    const state = randomToken();
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(stateHashOf(state)).toHaveLength(32);
    expect(randomToken()).not.toBe(state);
  });

  it("make RFC 7636's S256 challenge", () => {
    // RFC 7636 appendix B.
    expect(codeChallengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
});
