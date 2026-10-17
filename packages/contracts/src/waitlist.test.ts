import { describe, expect, it } from 'vitest';
import {
  MAX_WAITLIST_WINDOWS,
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
    });
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

  it('rejects anything but true or false for all', () => {
    expect(WaitlistQuerySchema.safeParse({ all: 'yes' }).success).toBe(false);
  });
});

describe('WaitlistChangeSchema', () => {
  it('only cancels', () => {
    expect(WaitlistChangeSchema.parse({ status: 'cancelled' })).toEqual({ status: 'cancelled' });
    expect(WaitlistChangeSchema.safeParse({ status: 'booked' }).success).toBe(false);
  });
});
