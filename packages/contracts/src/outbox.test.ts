import { describe, expect, it } from 'vitest';
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxDedupeKeySchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  OutboxMessageTypeSchema,
  OutboxStatusSchema,
  outboxRetryDelayMs,
} from './outbox.js';

describe('outbox schemas', () => {
  it('lowercases message ids and rejects anything else', () => {
    expect(OutboxMessageIdSchema.parse('0199F4B2-7C1E-7A00-8000-000000000001')).toBe(
      '0199f4b2-7c1e-7a00-8000-000000000001',
    );
    expect(OutboxMessageIdSchema.safeParse('not-an-id').success).toBe(false);
  });

  it('knows the message types and statuses', () => {
    expect(OutboxMessageTypeSchema.options).toEqual(['email', 'push', 'episode']);
    expect(OutboxStatusSchema.options).toEqual(['pending', 'sent', 'dead', 'cancelled']);
  });

  it.each(['booking.confirmed:0199f4b2-7c1e-7a00-8000-000000000001', 'a', 'x_y-z.1:2'])(
    'accepts the dedupe key %s',
    (key) => {
      expect(OutboxDedupeKeySchema.parse(key)).toBe(key);
    },
  );

  it.each(['', 'ana@example.com', 'has space', 'line\nbreak', 'x'.repeat(201)])(
    'rejects the dedupe key %j',
    (key) => {
      expect(OutboxDedupeKeySchema.safeParse(key).success).toBe(false);
    },
  );

  it('folds the subject onto one line', () => {
    const email = OutboxEmailSchema.parse({
      to: 'ana@example.com',
      subject: ' Booked\r\nBcc: someone@example.com ',
      text: 'Hi',
    });
    expect(email.subject).toBe('Booked Bcc: someone@example.com');
  });

  it.each([
    { to: 'not an address', subject: 'S', text: 'T' },
    { to: 'ana@example.com', subject: '   ', text: 'T' },
    { to: 'ana@example.com', subject: 'S', text: '' },
    { to: 'ana@example.com', subject: 'S'.repeat(301), text: 'T' },
    { to: 'ana@example.com', subject: 'S', text: 'T'.repeat(50_001) },
  ])('rejects the email %#', (email) => {
    expect(OutboxEmailSchema.safeParse(email).success).toBe(false);
  });

  it('backs off from 30 seconds, doubling, to at most an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(outboxRetryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000,
    ]);
    expect(outboxRetryDelayMs(0)).toBe(30_000);
    expect(outboxRetryDelayMs(50)).toBe(3_600_000);
    expect(OUTBOX_MAX_ATTEMPTS).toBe(8);
  });
});
