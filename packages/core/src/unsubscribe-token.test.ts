import { ClientIdSchema, TenantIdSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { outboxKeyFrom } from './outbox.js';
import { readUnsubscribeToken, unsubscribeKeyFrom, unsubscribeToken } from './unsubscribe-token.js';

const key = unsubscribeKeyFrom(outboxKeyFrom('a-test-outbox-secret-of-32-characters!'));
const other = unsubscribeKeyFrom(outboxKeyFrom('another-outbox-secret-of-32-characters'));
const subject = {
  tenantId: TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001'),
  clientId: ClientIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f700002'),
};

describe('unsubscribe links', () => {
  it('names the business and client it was made for, and nothing else', () => {
    const token = unsubscribeToken(key, subject);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readUnsubscribeToken(key, token)).toEqual(subject);
  });

  it('is the same link every time (no expiry, nothing stored)', () => {
    expect(unsubscribeToken(key, subject)).toBe(unsubscribeToken(key, subject));
  });

  it('refuses a link signed with another key, changed, cut or made up', () => {
    const token = unsubscribeToken(key, subject);
    expect(readUnsubscribeToken(other, token)).toBeNull();
    const bytes = Buffer.from(token, 'base64url');
    // Another client of the same business, with the old signature.
    bytes[32] = (bytes[32] ?? 0) ^ 1;
    expect(readUnsubscribeToken(key, bytes.toString('base64url'))).toBeNull();
    expect(readUnsubscribeToken(key, token.slice(0, -4))).toBeNull();
    expect(readUnsubscribeToken(key, 'A'.repeat(66))).toBeNull();
    expect(readUnsubscribeToken(key, '../etc/passwd')).toBeNull();
  });
});
