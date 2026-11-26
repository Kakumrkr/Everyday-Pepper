import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BookingSeriesInputSchema,
  SERIES_MAX_VISITS,
  SeriesRepeatSchema,
  seriesStarts,
  visitNumber,
} from './booking-series.js';
import { fromZoned, toZoned } from './zoned-time.js';

// The US zones of the V1 market (as the zoned-time and engine property tests).
const US_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

const NY = 'America/New_York';
const iso = (instant: number) => new Date(instant).toISOString();
const DAY_MS = 86_400_000;

// A first visit on a whole 5 minutes between 2025 and 2030 (several DST changes either way).
const firstStart = fc
  .integer({ min: Date.UTC(2025, 0, 1) / 300_000, max: Date.UTC(2030, 0, 1) / 300_000 })
  .map((fiveMinutes) => fiveMinutes * 300_000);
const repeat = fc.record({
  everyWeeks: fc.integer({ min: 1, max: 4 }),
  count: fc.integer({ min: 2, max: SERIES_MAX_VISITS }),
});

describe('seriesStarts (AC-X-181)', () => {
  it('every Tuesday 7 am for 8 weeks across the November change keeps 7 am', () => {
    const first = fromZoned(NY, { year: 2026, month: 10, day: 20 }, 7 * 60);
    const starts = seriesStarts(NY, first, { everyWeeks: 1, count: 8 });
    expect(starts.map(iso)).toEqual([
      '2026-10-20T11:00:00.000Z',
      '2026-10-27T11:00:00.000Z',
      '2026-11-03T12:00:00.000Z', // after the fall-back change: EST
      '2026-11-10T12:00:00.000Z',
      '2026-11-17T12:00:00.000Z',
      '2026-11-24T12:00:00.000Z',
      '2026-12-01T12:00:00.000Z',
      '2026-12-08T12:00:00.000Z',
    ]);
  });

  it('a time the spring change skips becomes the moment of the change', () => {
    // Sunday 2:30 am every 2 weeks; 8 March 2026 has no 2:30 in New York.
    const first = fromZoned(NY, { year: 2026, month: 2, day: 22 }, 150);
    const starts = seriesStarts(NY, first, { everyWeeks: 2, count: 3 });
    expect(starts.map(iso)).toEqual([
      '2026-02-22T07:30:00.000Z',
      '2026-03-08T07:00:00.000Z', // 3:00 EDT, the moment of the change
      '2026-03-22T06:30:00.000Z',
    ]);
  });

  it('property: exactly `count` dates, the first one itself, in order, none twice', () => {
    fc.assert(
      fc.property(fc.constantFrom(...US_TIME_ZONES), firstStart, repeat, (zone, first, rule) => {
        const starts = seriesStarts(zone, first, rule);
        expect(starts).toHaveLength(rule.count);
        expect(starts[0]).toBe(first);
        for (let index = 1; index < starts.length; index += 1) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- index in range
          const gap = starts[index]! - starts[index - 1]!;
          // N weeks apart, give or take the hour of a daylight-saving change.
          expect(Math.abs(gap - rule.everyWeeks * 7 * DAY_MS)).toBeLessThanOrEqual(3_600_000);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('property: every date is the same weekday every N weeks, at the same clock time unless skipped', () => {
    fc.assert(
      fc.property(fc.constantFrom(...US_TIME_ZONES), firstStart, repeat, (zone, first, rule) => {
        const local = toZoned(zone, first);
        const firstDay = Date.UTC(local.year, local.month - 1, local.day);
        seriesStarts(zone, first, rule).forEach((start, visit) => {
          const at = toZoned(zone, start);
          expect(at.weekday).toBe(local.weekday);
          const day = Date.UTC(at.year, at.month - 1, at.day);
          expect((day - firstDay) / DAY_MS).toBe(visit * rule.everyWeeks * 7);
          // The clock time holds, except one the spring change skipped (then within the hour).
          const drift = at.minuteOfDay - local.minuteOfDay;
          expect(drift === 0 || (drift > 0 && drift <= 60) || (drift < 0 && drift >= -60)).toBe(
            true,
          );
          if (drift !== 0) {
            // Only a skipped (or repeated) hour moves the clock: the wanted time doesn't exist
            // as asked, so asking for it again gives this same instant.
            expect(fromZoned(zone, at, local.minuteOfDay)).toBe(start);
          }
        });
      }),
      { numRuns: 300 },
    );
  });

  it('refuses a rule outside 1–4 weeks or 2–26 visits', () => {
    expect(SeriesRepeatSchema.safeParse({ everyWeeks: 0, count: 4 }).success).toBe(false);
    expect(SeriesRepeatSchema.safeParse({ everyWeeks: 5, count: 4 }).success).toBe(false);
    expect(SeriesRepeatSchema.safeParse({ everyWeeks: 1, count: 1 }).success).toBe(false);
    expect(SeriesRepeatSchema.safeParse({ everyWeeks: 1, count: 27 }).success).toBe(false);
    expect(() => seriesStarts(NY, Date.UTC(2026, 0, 6), { everyWeeks: 1, count: 30 })).toThrow();
  });
});

describe('BookingSeriesInputSchema', () => {
  const base = {
    clientId: '0e4b7c1a-5e0a-4d1c-9a6e-1f2b3c4d5e6f',
    serviceId: '1e4b7c1a-5e0a-4d1c-9a6e-1f2b3c4d5e6f',
    staffMemberId: '2e4b7c1a-5e0a-4d1c-9a6e-1f2b3c4d5e6f',
    everyWeeks: 1,
  };

  it('takes start times in order, a day or more apart, and emails by default', () => {
    const parsed = BookingSeriesInputSchema.parse({
      ...base,
      startsAts: ['2026-12-01T12:00:00Z', '2026-12-08T12:00:00Z'],
    });
    expect(parsed.notifyClient).toBe(true);
  });

  it.each([
    [['2026-12-08T12:00:00Z', '2026-12-01T12:00:00Z']],
    [['2026-12-01T12:00:00Z', '2026-12-01T12:00:00Z']],
    [['2026-12-01T12:00:00Z', '2026-12-01T20:00:00Z']],
    [['2026-12-01T12:00:00Z']],
  ])('refuses %j', (startsAts) => {
    expect(BookingSeriesInputSchema.safeParse({ ...base, startsAts }).success).toBe(false);
  });

  it('refuses an override or unknown fields', () => {
    const startsAts = ['2026-12-01T12:00:00Z', '2026-12-08T12:00:00Z'];
    expect(BookingSeriesInputSchema.safeParse({ ...base, startsAts, override: true }).success).toBe(
      false,
    );
  });
});

describe('visitNumber (AC-X-186)', () => {
  const visits = [
    { id: 'c', startsAt: '2026-12-15T12:00:00Z', status: 'confirmed' },
    { id: 'a', startsAt: '2026-12-01T12:00:00Z', status: 'completed' },
    { id: 'b', startsAt: '2026-12-08T12:00:00Z', status: 'cancelled' },
    { id: 'd', startsAt: '2026-12-22T12:00:00Z', status: 'confirmed' },
  ];

  it('counts the visits not cancelled, earliest first', () => {
    expect(visitNumber(visits, 'c')).toEqual({ number: 2, of: 3 });
    expect(visitNumber(visits, 'a')).toEqual({ number: 1, of: 3 });
  });

  it('is null for a cancelled visit or one not in the series', () => {
    expect(visitNumber(visits, 'b')).toBeNull();
    expect(visitNumber(visits, 'x')).toBeNull();
  });
});
