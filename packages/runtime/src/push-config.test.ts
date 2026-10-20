import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadPushConfig, loadPushPublicKey } from './config.js';

// A real P-256 key pair in the base64url form VAPID uses.
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = privateKey.export({ format: 'jwk' });
const PUBLIC = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url'),
  Buffer.from(String(publicKey.export({ format: 'jwk' }).y), 'base64url'),
]).toString('base64url');
const PRIVATE = String(jwk.d);

describe('loadPushConfig (ADR-0026)', () => {
  it('reads both keys and the subject, with a default subject', () => {
    expect(
      loadPushConfig('worker', { VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: PRIVATE }),
    ).toEqual({
      publicKey: PUBLIC,
      privateKey: PRIVATE,
      subject: 'mailto:bookings@pepper.localhost',
    });
    expect(
      loadPushConfig('api', {
        VAPID_PUBLIC_KEY: PUBLIC,
        VAPID_PRIVATE_KEY: PRIVATE,
        VAPID_SUBJECT: 'https://pepper.app',
      })?.subject,
    ).toBe('https://pepper.app');
  });

  it('is off without keys (empty counts as unset)', () => {
    expect(loadPushConfig('api', {})).toBeNull();
    expect(loadPushConfig('api', { VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })).toBeNull();
  });

  it('refuses one key without the other, wrong lengths and a bad subject, naming only the variable', () => {
    expect(() => loadPushConfig('api', { VAPID_PUBLIC_KEY: PUBLIC })).toThrow(
      'Invalid api environment',
    );
    expect(() =>
      loadPushConfig('api', { VAPID_PUBLIC_KEY: PRIVATE, VAPID_PRIVATE_KEY: PRIVATE }),
    ).toThrow('VAPID_PUBLIC_KEY');
    try {
      loadPushConfig('worker', {
        VAPID_PUBLIC_KEY: PUBLIC,
        VAPID_PRIVATE_KEY: `${PRIVATE}!`,
        VAPID_SUBJECT: 'ana',
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toContain('VAPID_PRIVATE_KEY');
      expect(String(error)).toContain('VAPID_SUBJECT');
      expect(String(error)).not.toContain(PRIVATE);
    }
  });
});

describe('loadPushPublicKey', () => {
  it('reads only the public key; unset is null; a malformed one is refused', () => {
    expect(
      loadPushPublicKey('api', { VAPID_PUBLIC_KEY: PUBLIC, VAPID_PRIVATE_KEY: 'ignored' }),
    ).toBe(PUBLIC);
    expect(loadPushPublicKey('api', { VAPID_PUBLIC_KEY: '' })).toBeNull();
    expect(() => loadPushPublicKey('api', { VAPID_PUBLIC_KEY: PRIVATE })).toThrow(
      'VAPID_PUBLIC_KEY',
    );
  });
});
