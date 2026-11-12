import type { LastBookingText } from '@pepper/db';
import { describe, expect, it } from 'vitest';
import { lastTextOf } from './services/sms.js';

// Where a client's last text stands, as the profile says it (S62 top-up, AC-X-76).

const QUEUED = new Date('2026-11-12T13:00:00.000Z');
const SENT = new Date('2026-11-12T13:00:05.000Z');
const text = (over: Partial<LastBookingText>): LastBookingText => ({
  kind: 'day_before',
  createdAt: QUEUED,
  messageStatus: 'pending',
  availableAt: QUEUED,
  sentAt: null,
  lastError: null,
  deliveryStatus: null,
  ...over,
});

describe('lastTextOf', () => {
  it('is null without a text', () => {
    expect(lastTextOf(undefined)).toBeNull();
  });

  it('waits until the time it may go (the quiet hours)', () => {
    const at = new Date('2026-11-13T13:00:00.000Z');
    expect(lastTextOf(text({ availableAt: at }))).toEqual({
      kind: 'day_before',
      at: at.toISOString(),
      state: 'waiting',
      reason: null,
    });
  });

  it('says sent, delivered or not delivered once the provider took it', () => {
    const sent = { messageStatus: 'sent' as const, sentAt: SENT };
    expect(lastTextOf(text(sent))).toMatchObject({ state: 'sent', at: SENT.toISOString() });
    expect(lastTextOf(text({ ...sent, deliveryStatus: 'queued' }))?.state).toBe('sent');
    expect(lastTextOf(text({ ...sent, deliveryStatus: 'delivered' }))?.state).toBe('delivered');
    expect(lastTextOf(text({ ...sent, deliveryStatus: 'undelivered' }))?.state).toBe(
      'not_delivered',
    );
    expect(lastTextOf(text({ ...sent, deliveryStatus: 'failed' }))?.state).toBe('not_delivered');
  });

  it('says why a text was not sent', () => {
    const dead = (lastError: string | null) =>
      lastTextOf(text({ messageStatus: 'dead', lastError, kind: 'opt_in' }));
    expect(dead('SmsOptedOut')).toMatchObject({ state: 'not_sent', reason: 'opted_out' });
    expect(dead('SmsNoConsent')).toMatchObject({ reason: 'no_consent' });
    expect(dead('SmsNotTextable')).toMatchObject({ reason: 'not_textable' });
    expect(dead('SmsRejectedError')).toMatchObject({ reason: 'failed' });
    expect(dead(null)).toMatchObject({ reason: 'failed', kind: 'opt_in' });
    expect(lastTextOf(text({ messageStatus: 'cancelled' }))).toMatchObject({ state: 'not_sent' });
  });
});
