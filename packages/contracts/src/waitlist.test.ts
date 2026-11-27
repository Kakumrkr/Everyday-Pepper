import { describe, expect, it } from 'vitest';
import {
  MAX_WAITLIST_WINDOWS,
  offerExpiry,
  WAITLIST_OFFER_LIMITS,
  WaitlistOfferStatusSchema,
  WaitlistChangeSchema,
  WaitlistEntryInputSchema,
  WaitlistQuerySchema,
  WaitlistWindowSchema,
} from './waitlist.js';

const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const SERVICE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';

const friday = { date: '2026-10-23', start: '15:00', end: '18:00' };
const monday = { date: '2026-10-19', start: '09:00', end: '12:00' };

describe('WaitlistWindowSchema', () => {
  it('accepts a window that ends at midnight', () => {
    expect(WaitlistWindowSchema.parse({ ...friday, end: '24:00' }).end).toBe('24:00');
  });

  it.each([
    ['an end before the start', { ...friday, end: '14:00' }],
    ['an empty window', { ...friday, end: '15:00' }],
    ['a start at 24:00', { ...friday, start: '24:00' }],
    ['a date that does not exist', { ...friday, date: '2026-02-30' }],
    ['a time without minutes', { ...friday, start: '9' }],
  ])('rejects %s', (_label, window) => {
    expect(WaitlistWindowSchema.safeParse(window).success).toBe(false);
  });
});

describe('WaitlistEntryInputSchema', () => {
  it('sorts windows, drops duplicates and defaults to any staff member', () => {
    expect(
      WaitlistEntryInputSchema.parse({
        clientId: CLIENT,
        serviceId: SERVICE,
        windows: [friday, monday, friday],
      }),
    ).toEqual({
      clientId: CLIENT,
      serviceId: SERVICE,
      staffMemberId: null,
      windows: [monday, friday],
      smsConsent: null,
    });
  });

  it('takes the texts a client agreed to only with v3 and a number Pepper can text (S79)', () => {
    const base = { clientId: CLIENT, serviceId: SERVICE, windows: [monday] };
    expect(
      WaitlistEntryInputSchema.parse({
        ...base,
        smsConsent: { phone: '+15125550123', wordingVersion: 'sms-consent-v3' },
      }).smsConsent,
    ).toEqual({ phone: '+15125550123', wordingVersion: 'sms-consent-v3' });
    for (const smsConsent of [
      { phone: '+15125550123', wordingVersion: 'sms-consent-v1' },
      { phone: '+442071838750', wordingVersion: 'sms-consent-v3' },
    ]) {
      expect(WaitlistEntryInputSchema.safeParse({ ...base, smsConsent }).success).toBe(false);
    }
  });

  it('sorts windows of one day by start', () => {
    const late = { date: monday.date, start: '13:00', end: '14:00' };
    const { windows } = WaitlistEntryInputSchema.parse({
      clientId: CLIENT,
      serviceId: SERVICE,
      windows: [late, monday],
    });
    expect(windows).toEqual([monday, late]);
  });

  it(`takes 1 to ${String(MAX_WAITLIST_WINDOWS)} windows`, () => {
    const entry = (count: number) => ({
      clientId: CLIENT,
      serviceId: SERVICE,
      windows: Array.from({ length: count }, (_, i) => ({
        date: `2026-11-${String(i + 1).padStart(2, '0')}`,
        start: '09:00',
        end: '17:00',
      })),
    });
    expect(WaitlistEntryInputSchema.safeParse(entry(0)).success).toBe(false);
    expect(WaitlistEntryInputSchema.safeParse(entry(MAX_WAITLIST_WINDOWS)).success).toBe(true);
    expect(WaitlistEntryInputSchema.safeParse(entry(MAX_WAITLIST_WINDOWS + 1)).success).toBe(false);
  });

  it('rejects a status or an expiry from the caller', () => {
    const base = { clientId: CLIENT, serviceId: SERVICE, windows: [friday] };
    expect(WaitlistEntryInputSchema.safeParse({ ...base, status: 'booked' }).success).toBe(false);
    expect(
      WaitlistEntryInputSchema.safeParse({ ...base, expiresAt: '2027-01-01T00:00:00.000Z' })
        .success,
    ).toBe(false);
  });
});

describe('WaitlistQuerySchema', () => {
  it('lists open entries by default and reads query strings', () => {
    expect(WaitlistQuerySchema.parse({})).toEqual({ all: false, limit: 100 });
    expect(WaitlistQuerySchema.parse({ all: 'true', limit: '5', serviceId: SERVICE })).toEqual({
      all: true,
      limit: 5,
      serviceId: SERVICE,
    });
  });

  it('takes a boolean from code; rejects anything but true or false', () => {
    expect(WaitlistQuerySchema.parse({ all: true }).all).toBe(true);
    expect(WaitlistQuerySchema.parse({ all: 'false' }).all).toBe(false);
    expect(WaitlistQuerySchema.safeParse({ all: 'yes' }).success).toBe(false);
  });
});

describe('WaitlistChangeSchema', () => {
  it('only cancels', () => {
    expect(WaitlistChangeSchema.parse({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(WaitlistChangeSchema.safeParse({ status: 'booked' }).success).toBe(false);
  });
});

describe('waitlist offers (S37, ADR-0041)', () => {
  const HOUR = 3_600_000;
  const now = Date.parse('2026-11-03T09:00:00Z');

  it('closes offers after 2 hours, or an hour before the slot when that is sooner', () => {
    expect(offerExpiry(now, now + 6 * HOUR)).toBe(now + 2 * HOUR);
    expect(offerExpiry(now, now + 3 * HOUR)).toBe(now + 2 * HOUR);
    expect(offerExpiry(now, now + 2.5 * HOUR)).toBe(now + 1.5 * HOUR);
    expect(offerExpiry(now, now + HOUR)).toBe(now);
  });

  it('fans out to 3 by default, at most 5', () => {
    expect(WAITLIST_OFFER_LIMITS.defaultFanOut).toBe(3);
    expect(WAITLIST_OFFER_LIMITS.maxFanOut).toBe(5);
  });

  it('has the four offer states of the playbook', () => {
    expect(WaitlistOfferStatusSchema.options).toEqual(['offered', 'claimed', 'taken', 'expired']);
  });
});
