import { VISIT_RISK_SIGNALS, VisitRiskSchema, type ClientId } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { MARIA, SAM, at, booking } from './fixtures.js';
import type { InsightBooking } from './types.js';
import { VISIT_RISK_HORIZON_DAYS, findVisitRisks, type VisitRiskInput } from './visit-risk.js';

// S77 (ADR-0071, AC-X-195…AC-X-199): the rules behind each upcoming visit's band.

const NOW = at('2026-12-01T12:00:00Z');
const DAY = 86_400_000;
const LEE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700013' as ClientId;

/** A past visit `daysAgo` days before now, an hour long. */
function past(daysAgo: number, overrides: Partial<InsightBooking> = {}): InsightBooking {
  const start = new Date(NOW - daysAgo * DAY).toISOString();
  const end = new Date(NOW - daysAgo * DAY + 3_600_000).toISOString();
  return booking(start, end, { status: 'completed', ...overrides });
}

/** An upcoming visit `daysAhead` days after now, booked `bookedDaysBefore` days before it. */
function ahead(
  daysAhead: number,
  overrides: Partial<InsightBooking> = {},
  bookedDaysBefore = 3,
): InsightBooking {
  const startMs = NOW + daysAhead * DAY;
  return booking(new Date(startMs).toISOString(), new Date(startMs + 3_600_000).toISOString(), {
    createdAt: startMs - bookedDaysBefore * DAY,
    ...overrides,
  });
}

function risks(bookings: readonly InsightBooking[], extra: Partial<VisitRiskInput> = {}) {
  return findVisitRisks({ now: NOW, bookings, cancelNoticeHours: 24, ...extra });
}

const regularHistory = (clientId: ClientId) =>
  Array.from({ length: 10 }, (_, i) => past(30 + i * 35, { clientId }));

describe('findVisitRisks', () => {
  it('a regular with no misses is low (AC-X-196)', () => {
    const visit = ahead(5, { clientConfirmedAt: NOW - DAY });
    const [risk] = risks([...regularHistory(MARIA), visit]);
    expect(risk).toMatchObject({ bookingId: visit.id, band: 'low', points: 0, reasons: [] });
  });

  it('a regular who was asked and has not confirmed tomorrow is still low', () => {
    const [risk] = risks([...regularHistory(MARIA), ahead(1, { confirmAskedAt: NOW - DAY })]);
    expect(risk).toMatchObject({
      band: 'low',
      reasons: [{ signal: 'not_confirmed', points: 1 }],
    });
  });

  it('a new client booked online 3 weeks ahead with no deposit is at least medium (AC-X-196)', () => {
    const [risk] = risks([ahead(10, { clientId: SAM, source: 'booking_page' }, 21)]);
    expect(risk?.band).toBe('medium');
    expect(risk?.reasons).toEqual([
      { signal: 'first_visit', points: 1 },
      { signal: 'booked_far_ahead', points: 1, days: 21 },
      { signal: 'online_no_deposit', points: 1 },
    ]);
  });

  it('a deposit or card taken removes the online signal', () => {
    const [risk] = risks([ahead(10, { clientId: SAM, source: 'booking_page', secured: true }, 21)]);
    expect(risk?.reasons.map((reason) => reason.signal)).toEqual([
      'first_visit',
      'booked_far_ahead',
    ]);
  });

  it('repeated misses and no confirmation tomorrow make it high, the misses first', () => {
    const history = [
      past(20, { status: 'no_show' }),
      past(60, { status: 'no_show' }),
      past(100, { status: 'no_show' }),
      past(140),
    ];
    const [risk] = risks([...history, ahead(1, { confirmAskedAt: NOW - DAY })]);
    expect(risk).toMatchObject({ band: 'high', points: 4 });
    expect(risk?.reasons[0]).toEqual({ signal: 'missed_before', points: 3, misses: 3, visits: 4 });
  });

  it('pulls a short history toward the shop: one miss in two visits is "some", not "often"', () => {
    const [risk] = risks([past(20, { status: 'no_show' }), past(60), ahead(5)]);
    // (1 + 5 × 0.1) / (2 + 5) = 0.21: at least 0.15, under 0.3.
    expect(risk?.reasons).toEqual([{ signal: 'missed_before', points: 2, misses: 1, visits: 2 }]);
  });

  it('uses the shop’s own rate once it has enough history', () => {
    // 40 visits of other clients, half of them missed: a shop rate of 0.5.
    const others = Array.from({ length: 40 }, (_, i) =>
      past(10 + i, { clientId: LEE, status: i % 2 === 0 ? 'no_show' : 'completed' }),
    );
    // Maria: one miss in five. With the 0.1 default it would be (1 + 0.5) / 10 = 0.15 → 2;
    // with the shop's 0.5 it is (1 + 2.5) / 10 = 0.35 → 3.
    const maria = [past(30, { status: 'no_show' }), past(60), past(90), past(120), past(150)];
    const scored = risks([...others, ...maria, ahead(5)]);
    expect(scored[0]?.reasons[0]).toMatchObject({ signal: 'missed_before', points: 3 });
  });

  it('a cancel inside the notice counts as a miss; an early one doesn’t', () => {
    const lateStart = NOW - 40 * DAY;
    const late = past(40, { status: 'cancelled', cancelledAt: lateStart - 2 * 3_600_000 });
    const earlyStart = NOW - 80 * DAY;
    const early = past(80, { status: 'cancelled', cancelledAt: earlyStart - 3 * DAY });
    const [risk] = risks([late, early, past(120), ahead(5)]);
    expect(risk?.reasons[0]).toEqual({ signal: 'missed_before', points: 2, misses: 1, visits: 2 });
    // A longer notice makes the early one late too.
    const [longer] = risks([late, early, past(120), ahead(5)], { cancelNoticeHours: 168 });
    expect(longer?.reasons[0]).toMatchObject({ misses: 2, visits: 3 });
  });

  it('scores not_confirmed only once the client was asked (AC-X-201)', () => {
    const [unasked] = risks([...regularHistory(MARIA), ahead(1)]);
    expect(unasked?.reasons).toEqual([]);
    const [asked] = risks([...regularHistory(MARIA), ahead(1, { confirmAskedAt: NOW - DAY })]);
    expect(asked?.reasons).toEqual([{ signal: 'not_confirmed', points: 1 }]);
    const [answered] = risks([
      ...regularHistory(MARIA),
      ahead(1, { confirmAskedAt: NOW - DAY, clientConfirmedAt: NOW - 3_600_000 }),
    ]);
    expect(answered?.reasons).toEqual([]);
  });

  it('a business’s late cancel is never the client’s miss; the client’s and an unknown one are (AC-X-200)', () => {
    const lateStart = NOW - 40 * DAY;
    const late = (cancelledBy: 'client' | 'business' | null) =>
      past(40, { status: 'cancelled', cancelledAt: lateStart - 2 * 3_600_000, cancelledBy });
    const [byBusiness] = risks([late('business'), past(80), past(120), ahead(5)]);
    expect(byBusiness?.reasons).toEqual([]);
    const [byClient] = risks([late('client'), past(80), past(120), ahead(5)]);
    expect(byClient?.reasons[0]).toEqual({
      signal: 'missed_before',
      points: 2,
      misses: 1,
      visits: 3,
    });
    const [unknown] = risks([late(null), past(80), past(120), ahead(5)]);
    expect(unknown?.reasons[0]).toMatchObject({ misses: 1, visits: 3 });
  });

  it('scores only confirmed visits from now to the horizon, earliest first', () => {
    const later = ahead(10);
    const soon = ahead(2);
    const scored = risks([
      later,
      ahead(VISIT_RISK_HORIZON_DAYS + 1),
      ahead(3, { status: 'cancelled', cancelledAt: NOW - DAY }),
      soon,
      past(1, { status: 'confirmed' }),
    ]);
    expect(scored.map((risk) => risk.bookingId)).toEqual([soon.id, later.id]);
  });

  it('names only the earliest upcoming visit of a new client as the first', () => {
    const scored = risks([ahead(2, { clientId: SAM }), ahead(9, { clientId: SAM })]);
    expect(scored[0]?.reasons.map((reason) => reason.signal)).toContain('first_visit');
    expect(scored[1]?.reasons.map((reason) => reason.signal)).not.toContain('first_visit');
  });

  it('an imported visit says nothing about how far ahead it was booked', () => {
    const [risk] = risks([...regularHistory(MARIA), ahead(10, { source: 'import' }, 60)]);
    expect(risk?.reasons).toEqual([]);
  });

  it('the same bookings in any order give the same risks, every one valid', () => {
    const bookings = [
      ...regularHistory(MARIA),
      past(15, { clientId: SAM, status: 'no_show' }),
      ahead(1, { clientId: SAM, source: 'booking_page' }, 20),
      ahead(4),
      ahead(6, { clientId: LEE }),
    ];
    const once = risks(bookings);
    expect(risks(bookings.toReversed())).toEqual(once);
    for (const risk of once) {
      expect(
        VisitRiskSchema.safeParse({ band: risk.band, points: risk.points, reasons: risk.reasons })
          .success,
      ).toBe(true);
    }
  });
});

describe('visit risk signals (behaviour only, AC-X-197)', () => {
  it('lists exactly the five booking-behaviour signals', () => {
    expect(VISIT_RISK_SIGNALS).toEqual([
      'missed_before',
      'first_visit',
      'booked_far_ahead',
      'online_no_deposit',
      'not_confirmed',
    ]);
  });

  it('reads no field of a booking but its behaviour', () => {
    const read = new Set<string>();
    const watch = (row: InsightBooking): InsightBooking =>
      new Proxy(row, {
        get(target, key, receiver) {
          if (typeof key === 'string') read.add(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
    risks(
      [
        ...regularHistory(MARIA),
        past(15, { clientId: SAM, status: 'no_show' }),
        past(25, { clientId: SAM, status: 'cancelled', cancelledAt: NOW - 25 * DAY - 3_600_000 }),
        ahead(1, { clientId: SAM, source: 'booking_page', confirmAskedAt: NOW - DAY }, 20),
        ahead(4),
      ].map(watch),
    );
    const allowed = new Set([
      'id',
      'clientId',
      'start',
      'status',
      'source',
      'createdAt',
      'clientConfirmedAt',
      'confirmAskedAt',
      'cancelledAt',
      'cancelledBy',
      'secured',
    ]);
    expect([...read].filter((key) => !allowed.has(key))).toEqual([]);
    // Never a name, an age, a gender, an address or a way to reach them.
    for (const key of read) {
      expect(key).not.toMatch(/name|age|birth|gender|sex|address|zip|phone|email|tag/i);
    }
  });
});
