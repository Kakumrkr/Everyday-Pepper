import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  formatDate,
  fromZoned,
  isoWeekday,
  offsetMinutes,
  parseDate,
  toZoned,
} from './zoned-time.js';

// The US zones of the V1 market (the appointments engine's property tests use the same set).
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
const at = (iso: string) => Date.parse(iso);
const iso = (instant: number) => new Date(instant).toISOString();

describe('offsetMinutes', () => {
  it.each([
    [NY, '2026-01-15T12:00:00Z', -300],
    [NY, '2026-07-15T12:00:00Z', -240],
    ['America/Phoenix', '2026-07-15T12:00:00Z', -420],
    ['Pacific/Honolulu', '2026-07-15T12:00:00Z', -600],
    ['UTC', '2026-07-15T12:00:00Z', 0],
    ['Asia/Kolkata', '2026-07-15T12:00:00Z', 330],
  ])('%s at %s is %i', (zone, instant, offset) => {
    expect(offsetMinutes(zone, at(instant))).toBe(offset);
  });

  it('ignores milliseconds', () => {
    expect(offsetMinutes(NY, at('2026-01-15T12:00:00.999Z'))).toBe(-300);
  });
});

describe('toZoned', () => {
  it('reads the local date, weekday and minute', () => {
    // 03:30 UTC on Thursday 15 October is 23:30 on Wednesday 14 October in New York.
    expect(toZoned(NY, at('2026-10-15T03:30:00Z'))).toEqual({
      year: 2026,
      month: 10,
      day: 14,
      weekday: 3,
      minuteOfDay: 23 * 60 + 30,
    });
  });

  it('shows midnight as minute 0', () => {
    expect(toZoned(NY, at('2026-10-15T04:00:00Z'))).toMatchObject({ day: 15, minuteOfDay: 0 });
  });
});

describe('fromZoned', () => {
  const spring = { year: 2026, month: 3, day: 8 };
  const fall = { year: 2026, month: 11, day: 1 };

  it('converts ordinary times', () => {
    expect(iso(fromZoned(NY, { year: 2026, month: 10, day: 15 }, 9 * 60))).toBe(
      '2026-10-15T13:00:00.000Z',
    );
    expect(iso(fromZoned(NY, { year: 2026, month: 1, day: 15 }, 9 * 60))).toBe(
      '2026-01-15T14:00:00.000Z',
    );
  });

  it('maps a time skipped by spring-forward to the moment of the change', () => {
    // 02:00–02:59 do not exist on 8 March 2026 in New York: the clock jumps to 03:00 EDT.
    expect(iso(fromZoned(NY, spring, 2 * 60 + 30))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(fromZoned(NY, spring, 2 * 60 + 59))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(fromZoned(NY, spring, 2 * 60))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(fromZoned(NY, spring, 3 * 60))).toBe('2026-03-08T07:00:00.000Z');
    expect(iso(fromZoned(NY, spring, 60 + 59))).toBe('2026-03-08T06:59:00.000Z');
  });

  it('takes the earlier instant for a time repeated by fall-back', () => {
    // 01:30 happens twice on 1 November 2026 in New York (EDT, then EST).
    expect(iso(fromZoned(NY, fall, 60 + 30))).toBe('2026-11-01T05:30:00.000Z');
    expect(iso(fromZoned(NY, fall, 2 * 60))).toBe('2026-11-01T07:00:00.000Z');
  });

  it('treats 24:00 as the next midnight', () => {
    expect(fromZoned(NY, { year: 2026, month: 10, day: 14 }, 1440)).toBe(
      fromZoned(NY, { year: 2026, month: 10, day: 15 }, 0),
    );
  });

  it('round-trips every instant (the repeated hour maps to its first occurrence)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...US_TIME_ZONES),
        fc.integer({
          min: at('2020-01-01T00:00:00Z') / 60_000,
          max: at('2035-01-01T00:00:00Z') / 60_000,
        }),
        (zone, minute) => {
          const instant = minute * 60_000;
          const local = toZoned(zone, instant);
          const back = fromZoned(zone, local, local.minuteOfDay);
          // Either the same instant, or the earlier one of a repeated (fall-back) hour.
          expect([0, -60 * 60_000]).toContain(back - instant);
          expect(toZoned(zone, back)).toEqual(local);
        },
      ),
      { numRuns: 10_000 },
    );
  }, 60_000);

  it('shows the asked-for wall-clock time, or the end of the gap that skipped it', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...US_TIME_ZONES),
        fc.integer({ min: 0, max: 15 * 366 }),
        fc.integer({ min: 0, max: 1439 }),
        (zone, dayOffset, minuteOfDay) => {
          const date = addDays({ year: 2020, month: 1, day: 1 }, dayOffset);
          const instant = fromZoned(zone, date, minuteOfDay);
          const shown = toZoned(zone, instant);
          // No US zone changes its clocks near midnight, so the day never changes.
          expect(formatDate(shown)).toBe(formatDate(date));
          const skipped = shown.minuteOfDay - minuteOfDay;
          // US changes are one hour: shown as asked, or up to an hour later when skipped.
          expect(skipped).toBeGreaterThanOrEqual(0);
          expect(skipped).toBeLessThanOrEqual(60);
          if (skipped > 0) {
            // Exactly the moment the clock jumped forward.
            expect(offsetMinutes(zone, instant)).toBe(offsetMinutes(zone, instant - 60_000) + 60);
          }
        },
      ),
      { numRuns: 10_000 },
    );
  }, 60_000);

  it('never maps a later wall-clock time to an earlier instant', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...US_TIME_ZONES),
        fc.integer({ min: 0, max: 15 * 366 }),
        fc.integer({ min: 0, max: 1440 }),
        fc.integer({ min: 0, max: 1440 }),
        (zone, dayOffset, a, b) => {
          const date = addDays({ year: 2020, month: 1, day: 1 }, dayOffset);
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(fromZoned(zone, date, low)).toBeLessThanOrEqual(fromZoned(zone, date, high));
        },
      ),
      { numRuns: 10_000 },
    );
  }, 60_000);
});

describe('calendar dates', () => {
  it('gives ISO weekdays', () => {
    expect(isoWeekday({ year: 2026, month: 10, day: 12 })).toBe(1);
    expect(isoWeekday({ year: 2026, month: 10, day: 18 })).toBe(7);
  });

  it('adds days across months, years and leap days', () => {
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
  });

  it('formats and parses YYYY-MM-DD', () => {
    expect(formatDate({ year: 2026, month: 3, day: 8 })).toBe('2026-03-08');
    expect(parseDate('2026-03-08')).toEqual({ year: 2026, month: 3, day: 8 });
  });
});
