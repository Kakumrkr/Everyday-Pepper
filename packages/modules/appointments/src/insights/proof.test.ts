import { MINUTES_SAVED } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { KOLKATA, MARIA, NY, SAM, at, booking } from './fixtures.js';
import { buildEveningWrap, buildWeekValue, type WeekBooking } from './proof.js';

// Proof of value (S55, AC-W4-10…12). Expected sums are written out, not recomputed.

let seq = 0;
const visit = (overrides: Partial<WeekBooking> = {}): WeekBooking => {
  seq += 1;
  return {
    id: `b${String(seq)}`,
    clientId: `c${String(seq)}`,
    source: 'team',
    priceCents: 5000,
    filled: false,
    nudged: false,
    ...overrides,
  };
};
const none = new Map<string, number>();

describe('buildWeekValue', () => {
  it('counts the visits Pepper had a hand in, each once in the dollars', () => {
    const week = buildWeekValue(
      [
        visit({ source: 'booking_page', priceCents: 4000 }),
        visit({ source: 'ai', priceCents: 6000 }),
        // A fill booked through the offer's page: one visit, one fill.
        visit({ source: 'booking_page', priceCents: 8000, filled: true }),
        // The owner booked a regular who came back after a nudge.
        visit({ source: 'team', priceCents: 3000, nudged: true }),
        // The owner's own booking: not Pepper's.
        visit({ source: 'team', priceCents: 9900 }),
      ],
      none,
    );
    expect(week).toEqual({
      visitsBooked: 4,
      gapsFilled: 1,
      regularsBack: 1,
      regularsBackCents: 3000,
      valueCents: 21_000,
      minutesSaved: 3 * MINUTES_SAVED.booking + MINUTES_SAVED.fill,
    });
  });

  it('counts a regular once, by their first booking after the nudge', () => {
    const week = buildWeekValue(
      [
        visit({ clientId: 'ana', nudged: true, priceCents: 4500 }),
        visit({ clientId: 'ana', nudged: true, priceCents: 7000 }),
      ],
      none,
    );
    expect(week).toMatchObject({
      visitsBooked: 1,
      regularsBack: 1,
      regularsBackCents: 4500,
      valueCents: 4500,
    });
  });

  it("a regular's booking online counts its dollars once, in both lines", () => {
    const week = buildWeekValue(
      [visit({ source: 'booking_page', nudged: true, filled: true, priceCents: 6000 })],
      none,
    );
    expect(week).toEqual({
      visitsBooked: 1,
      gapsFilled: 1,
      regularsBack: 1,
      regularsBackCents: 6000,
      valueCents: 6000,
      minutesSaved: MINUTES_SAVED.booking + MINUTES_SAVED.fill,
    });
  });

  it('an unpriced visit counts, worth nothing', () => {
    expect(buildWeekValue([visit({ source: 'ai', priceCents: null })], none)).toMatchObject({
      visitsBooked: 1,
      valueCents: 0,
    });
  });

  it("adds the AI's other actions: emails at the message rate, the rest at the action rate", () => {
    const week = buildWeekValue(
      [],
      new Map([
        ['message.rebooking_nudge', 3],
        ['message.confirmation', 2],
        ['booking.move', 4],
        // Its bookings are the visits' minutes already.
        ['booking.create', 5],
      ]),
    );
    expect(week).toEqual({
      visitsBooked: 0,
      gapsFilled: 0,
      regularsBack: 0,
      regularsBackCents: 0,
      valueCents: 0,
      minutesSaved: 5 * MINUTES_SAVED.message + 4 * MINUTES_SAVED.action,
    });
  });

  it('is all zeros for a quiet week', () => {
    expect(buildWeekValue([], none)).toEqual({
      visitsBooked: 0,
      gapsFilled: 0,
      regularsBack: 0,
      regularsBackCents: 0,
      valueCents: 0,
      minutesSaved: 0,
    });
  });
});

describe('buildEveningWrap', () => {
  // Wednesday 2026-11-04 in New York (UTC−5).
  const evening = at('2026-11-04T22:30:00Z'); // 17:30 local
  const tomorrowAt = (hour: number) =>
    `2026-11-05T${String(hour + 5).padStart(2, '0')}:00:00Z` as const;
  const tomorrowVisit = (hour: number, overrides: Parameters<typeof booking>[2] = {}) =>
    booking(tomorrowAt(hour), tomorrowAt(hour + 1), overrides);
  const noShow = (iso: string, clientId = SAM) =>
    booking(iso, iso, { clientId, status: 'no_show' });

  it('is null before the evening hour', () => {
    expect(buildEveningWrap([tomorrowVisit(9)], NY, at('2026-11-04T21:59:00Z'), 24)).toBeNull();
  });

  it("counts tomorrow's standing visits from the first, in local time", () => {
    const first = tomorrowVisit(9);
    const wrap = buildEveningWrap(
      [
        tomorrowVisit(14),
        first,
        tomorrowVisit(11, { status: 'cancelled' }),
        // Today's and the day after's are not tomorrow's.
        booking('2026-11-04T23:00:00Z', '2026-11-04T23:30:00Z'),
        booking('2026-11-06T05:00:00Z', '2026-11-06T06:00:00Z'),
      ],
      NY,
      evening,
      24,
    );
    expect(wrap).toEqual({
      day: '2026-11-05',
      visitCount: 2,
      firstStartsAt: '2026-11-05T14:00:00.000Z',
      atRisk: [],
    });
    expect(first.start).toBe(at('2026-11-05T14:00:00Z'));
  });

  it('names the visits in the high risk band with their top reason (S77, AC-X-199)', () => {
    // Sam missed 3 of 4 and hasn't confirmed when asked: high. Maria missed 1 of 3: medium,
    // not named.
    const risky = tomorrowVisit(10, { clientId: SAM, confirmAskedAt: evening - 3_600_000 });
    const wrap = buildEveningWrap(
      [
        noShow('2026-09-01T15:00:00Z'),
        noShow('2026-10-01T15:00:00Z'),
        noShow('2026-10-15T15:00:00Z'),
        booking('2026-08-01T15:00:00Z', '2026-08-01T16:00:00Z', {
          clientId: SAM,
          status: 'completed',
        }),
        noShow('2026-10-02T15:00:00Z', MARIA),
        booking('2026-08-02T15:00:00Z', '2026-08-02T16:00:00Z', { status: 'completed' }),
        booking('2026-07-02T15:00:00Z', '2026-07-02T16:00:00Z', { status: 'completed' }),
        risky,
        tomorrowVisit(12, { clientId: MARIA }),
      ],
      NY,
      evening,
      24,
    );
    expect(wrap?.visitCount).toBe(2);
    expect(wrap?.atRisk).toEqual([
      {
        bookingId: risky.id,
        clientId: SAM,
        startsAt: '2026-11-05T15:00:00.000Z',
        topReason: { signal: 'missed_before', points: 3, misses: 3, visits: 4 },
      },
    ]);
  });

  it('leaves out a high-band visit that is not tomorrow', () => {
    const later = booking('2026-11-07T15:00:00Z', '2026-11-07T16:00:00Z', {
      clientId: SAM,
      source: 'booking_page',
      createdAt: at('2026-10-01T15:00:00Z'),
    });
    const wrap = buildEveningWrap(
      [noShow('2026-09-01T15:00:00Z'), noShow('2026-10-01T15:00:00Z'), later],
      NY,
      evening,
      24,
    );
    expect(wrap?.atRisk).toEqual([]);
  });

  it('is an empty tomorrow, not null, when nothing is booked', () => {
    expect(buildEveningWrap([], NY, evening, 24)).toEqual({
      day: '2026-11-05',
      visitCount: 0,
      firstStartsAt: null,
      atRisk: [],
    });
  });

  it("reads tomorrow from the business's own midnight east of UTC", () => {
    // 18:00 on Wednesday in Kolkata (UTC+5:30) is 12:30 UTC; Thursday starts at 18:30 UTC.
    const wrap = buildEveningWrap(
      [
        booking('2026-11-04T18:30:00Z', '2026-11-04T19:00:00Z'),
        booking('2026-11-04T18:00:00Z', '2026-11-04T18:20:00Z'),
      ],
      KOLKATA,
      at('2026-11-04T12:30:00Z'),
      24,
    );
    expect(wrap).toMatchObject({ day: '2026-11-05', visitCount: 1 });
  });
});
