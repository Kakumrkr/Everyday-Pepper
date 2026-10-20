import { describe, expect, it } from 'vitest';
import { OutboxPushSchema } from './outbox.js';
import { PushEndpointSchema, PushKeyResponseSchema, PushSubscriptionInputSchema } from './push.js';

const keys = { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';

describe('PushSubscriptionInputSchema (ADR-0026)', () => {
  it("takes the browser's subscription as toJSON() gives it", () => {
    expect(
      PushSubscriptionInputSchema.parse({ endpoint: ENDPOINT, expirationTime: null, keys }),
    ).toEqual({ endpoint: ENDPOINT, expirationTime: null, keys });
  });

  it.each([
    { endpoint: 'http://push.example.test/x', keys },
    { endpoint: `https://push.example.test/${'x'.repeat(1000)}`, keys },
    { endpoint: ENDPOINT, keys: { p256dh: 'short', auth: keys.auth } },
    { endpoint: ENDPOINT, keys: { ...keys, auth: 'not base64url!' } },
    { endpoint: ENDPOINT, keys: { ...keys, extra: 'x' } },
  ])('refuses %j', (input) => {
    expect(PushSubscriptionInputSchema.safeParse(input).success).toBe(false);
  });

  it('names a device by its https endpoint only', () => {
    expect(PushEndpointSchema.safeParse({ endpoint: ENDPOINT }).success).toBe(true);
    expect(PushEndpointSchema.safeParse({ endpoint: 'ftp://x' }).success).toBe(false);
    expect(PushKeyResponseSchema.parse({ publicKey: null })).toEqual({ publicKey: null });
  });
});

describe('OutboxPushSchema', () => {
  const push = {
    subscriptionId: '0199f4b2-7c1e-7a00-8000-000000000001',
    title: 'New booking',
    body: 'Haircut',
  };

  it('opens only pages of the app', () => {
    for (const url of ['/', '/calendar?date=2026-11-03', '/clients/abc#visits']) {
      expect(OutboxPushSchema.safeParse({ ...push, url }).success, url).toBe(true);
    }
    for (const url of ['https://evil.test', '//evil.test', '/\\\\evil.test', 'calendar', '']) {
      expect(OutboxPushSchema.safeParse({ ...push, url }).success, url).toBe(false);
    }
  });

  it('keeps titles and lines short, and tags plain', () => {
    expect(OutboxPushSchema.safeParse({ ...push, url: '/', title: 'x'.repeat(101) }).success).toBe(
      false,
    );
    expect(OutboxPushSchema.safeParse({ ...push, url: '/', body: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(OutboxPushSchema.safeParse({ ...push, url: '/', tag: 'has space' }).success).toBe(false);
    expect(OutboxPushSchema.parse({ ...push, url: '/', tag: 'booking-1' }).tag).toBe('booking-1');
  });
});
