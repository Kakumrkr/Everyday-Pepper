import type { FeedItem } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { feedValueCents, pricePerMinute, type PricedService } from './services/feed-value.js';

const SERVICES: PricedService[] = [
  { id: 'cut', durationMinutes: 30, priceFromCents: 3000, active: true },
  { id: 'fade', durationMinutes: 60, priceFromCents: 9000, active: true },
  // Not counted: archived, unpriced.
  { id: 'old', durationMinutes: 10, priceFromCents: 100_000, active: false },
  { id: 'consult', durationMinutes: 15, priceFromCents: null, active: true },
];
const PRICES = {
  services: SERVICES,
  bookingPrices: new Map([
    ['b1', 4500],
    ['b2', null],
  ]),
};
const RATE = pricePerMinute(SERVICES);

const base = {
  id: '00000000-0000-4000-8000-000000000001',
  status: 'suggestion',
  day: '2099-01-05',
  subjects: { staffMemberId: null, clientId: null, bookingId: null, serviceId: null },
  names: { staff: null, client: null, service: null },
  proposalId: null,
  expiresAt: '2099-01-06T00:00:00.000Z',
  createdAt: '2099-01-05T00:00:00.000Z',
} as const;
const item = (rest: object) => ({ ...base, ...rest }) as unknown as FeedItem;

describe('Home dollar estimates (AC-W4-4)', () => {
  it('prices a minute by total price over total length of active priced services', () => {
    expect(RATE).toBe(12_000 / 90);
    expect(pricePerMinute([])).toBeNull();
    expect(
      pricePerMinute([{ id: 'x', durationMinutes: 30, priceFromCents: null, active: true }]),
    ).toBeNull();
  });

  it('prices open time at that rate, rounded to whole cents', () => {
    const gaps = item({
      kind: 'schedule_gaps',
      payload: {
        gapCount: 1,
        openMinutes: 45,
        longestStartsAt: base.createdAt,
        longestEndsAt: base.expiresAt,
      },
    });
    expect(feedValueCents(gaps, PRICES, RATE)).toBe(6000);
    expect(feedValueCents(gaps, PRICES, null)).toBeNull();
  });

  it('prices a freed time by its length, and nothing once claimed', () => {
    const match = (state: string) =>
      item({
        kind: 'waitlist_match',
        payload: {
          startsAt: '2099-01-05T15:00:00.000Z',
          endsAt: '2099-01-05T15:30:00.000Z',
          state,
          offered: 1,
        },
      });
    expect(feedValueCents(match('offered'), PRICES, RATE)).toBe(4000);
    expect(feedValueCents(match('claimed'), PRICES, RATE)).toBeNull();
  });

  it("prices a regular by their service's price and a no-show risk by the booking's", () => {
    const due = (serviceId: string | null) =>
      item({
        kind: 'rebooking_due',
        subjects: { ...base.subjects, serviceId },
        payload: {
          lastVisitAt: base.createdAt,
          intervalDays: 28,
          basis: 'service',
          dueOn: '2099-01-01',
        },
      });
    expect(feedValueCents(due('fade'), PRICES, RATE)).toBe(9000);
    expect(feedValueCents(due('consult'), PRICES, RATE)).toBeNull();
    expect(feedValueCents(due(null), PRICES, RATE)).toBeNull();
    const risk = (bookingId: string) =>
      item({
        kind: 'no_show_pattern',
        subjects: { ...base.subjects, bookingId },
        payload: { noShowCount: 2, windowDays: 90, bookingStartsAt: base.expiresAt },
      });
    expect(feedValueCents(risk('b1'), PRICES, RATE)).toBe(4500);
    expect(feedValueCents(risk('b2'), PRICES, RATE)).toBeNull();
    expect(feedValueCents(risk('unseen'), PRICES, RATE)).toBeNull();
  });

  it('has no price for a busy week', () => {
    const busy = item({
      kind: 'staff_overload',
      payload: { busyDays: ['2099-01-05'], horizonDays: 7, peakPercent: 95 },
    });
    expect(feedValueCents(busy, PRICES, RATE)).toBeNull();
  });
});
