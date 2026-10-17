import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { availableSlots, type AvailabilityQuery, type Interval, type Slot } from './engine.js';
import { queryArb } from './test-arbitraries.js';
import { fromZoned, isoWeekday, parseDate, type CivilDate } from './zoned-time.js';

// Property tests for the availability engine (ADR-0016, 10k cases each, as the testing
// strategy asks). The checks below read local dates with `Intl` directly and test overlaps
// naively, independently of the engine; local → UTC uses `fromZoned`, which has its own
// property tests in `zoned-time.test.ts`.

const RUNS = { numRuns: 10_000 };
/** 10k runs take tens of seconds. */
const TIMEOUT_MS = 180_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` the business's calendar shows at `instant`. */
function localDate(timeZone: string, instant: number): string {
  let format = dateFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' });
    dateFormats.set(timeZone, format);
  }
  return format.format(instant);
}
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** `fromZoned`, remembered: the checks below ask for the same window bounds many times. */
function windowBound(timeZone: string, day: CivilDate, minuteOfDay: number): number {
  const key = `${timeZone} ${String(day.year)}-${String(day.month)}-${String(day.day)} ${String(minuteOfDay)}`;
  let instant = bounds.get(key);
  if (instant === undefined) {
    instant = fromZoned(timeZone, day, minuteOfDay);
    bounds.set(key, instant);
  }
  return instant;
}
const bounds = new Map<string, number>();

function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Everything that must hold for one offered slot. */
function violations(query: AvailabilityQuery, slot: Slot): string[] {
  const problems: string[] = [];
  const { service, timeZone } = query;
  const staff = query.staff.find((s) => s.staffMemberId === slot.staffMemberId);
  if (staff === undefined) return ['unknown staff member'];
  const { rules } = staff;
  const date = localDate(timeZone, slot.start);
  const step = rules.slotIntervalMinutes * MINUTE_MS;

  if (!service.active || !staff.active || !staff.serviceIds.includes(service.id)) {
    problems.push('not bookable at all');
  }
  if (slot.end - slot.start !== service.durationMinutes * MINUTE_MS) problems.push('wrong length');
  if (slot.start < query.from || slot.start >= query.to) problems.push('outside the range');
  if (slot.start < query.now + rules.minimumNoticeMinutes * MINUTE_MS) problems.push('too soon');
  if (slot.start >= query.now + rules.maximumAdvanceDays * DAY_MS) problems.push('too far ahead');

  const day = parseDate(date);
  const inHours = staff.hours.some((window) => {
    if (window.weekday !== isoWeekday(day)) return false;
    const start = windowBound(timeZone, day, window.startMinute);
    const end = windowBound(timeZone, day, window.endMinute);
    return start <= slot.start && slot.end <= end && (slot.start - start) % step === 0;
  });
  if (!inHours) problems.push('outside working hours or off the grid');

  const occupied = {
    start: slot.start - service.bufferBeforeMinutes * MINUTE_MS,
    end: slot.end + service.bufferAfterMinutes * MINUTE_MS,
  };
  if (staff.timeOff.some((t) => overlaps(t, occupied))) problems.push('in time off');
  if (staff.busy.some((b) => overlaps(b, occupied))) problems.push('in outside busy time');
  const clash = staff.bookings.some((b) =>
    overlaps(
      {
        start: b.start - b.bufferBeforeMinutes * MINUTE_MS,
        end: b.end + b.bufferAfterMinutes * MINUTE_MS,
      },
      occupied,
    ),
  );
  if (clash) problems.push('double booked');
  if (rules.blackouts.some((b) => b.startDate <= date && date <= b.endDate)) {
    problems.push('blacked out');
  }
  const booked = staff.bookings.filter((b) => localDate(timeZone, b.start) === date).length;
  if (rules.maxBookingsPerDay !== null && booked >= rules.maxBookingsPerDay) {
    problems.push('daily cap reached');
  }
  return problems;
}

/** Every grid start that passes `violations`: a slow, obviously-complete enumeration. */
function bruteForce(query: AvailabilityQuery): Slot[] {
  const expected: Slot[] = [];
  const firstDay = parseDate(localDate(query.timeZone, query.from - DAY_MS));
  const dayCount = Math.ceil((query.to - query.from) / DAY_MS) + 3;
  for (const staff of query.staff) {
    const step = staff.rules.slotIntervalMinutes * MINUTE_MS;
    const duration = query.service.durationMinutes * MINUTE_MS;
    for (let offset = 0; offset < dayCount; offset++) {
      const day = parseDate(
        new Date(Date.UTC(firstDay.year, firstDay.month - 1, firstDay.day + offset))
          .toISOString()
          .slice(0, 10),
      );
      for (const window of staff.hours.filter((w) => w.weekday === isoWeekday(day))) {
        const end = windowBound(query.timeZone, day, window.endMinute);
        const first = windowBound(query.timeZone, day, window.startMinute);
        for (let start = first; start + duration <= end; start += step) {
          // Cheap test first; `violations` checks the range again.
          if (start < query.from || start >= query.to) continue;
          const slot = { staffMemberId: staff.staffMemberId, start, end: start + duration };
          if (violations(query, slot).length === 0) expected.push(slot);
        }
      }
    }
  }
  return expected.sort((a, b) => a.start - b.start || (a.staffMemberId < b.staffMemberId ? -1 : 1));
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
  }
  return copy;
}

describe('availableSlots (properties)', () => {
  it(
    'offers only slots that respect hours, time off, buffers, bookings and every rule',
    () => {
      fc.assert(
        fc.property(queryArb, (query) => {
          for (const slot of availableSlots(query)) {
            expect(violations(query, slot), new Date(slot.start).toISOString()).toEqual([]);
          }
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'offers every such slot exactly once, sorted by start and staff member',
    () => {
      fc.assert(
        fc.property(queryArb, (query) => {
          expect(availableSlots(query)).toEqual(bruteForce(query));
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'is deterministic and ignores the order of its inputs',
    () => {
      fc.assert(
        fc.property(queryArb, fc.integer({ min: 1, max: 1_000_000 }), (query, seed) => {
          const reordered: AvailabilityQuery = {
            ...query,
            staff: shuffled(query.staff, seed).map((staff) => ({
              ...staff,
              hours: shuffled(staff.hours, seed + 1),
              timeOff: shuffled(staff.timeOff, seed + 2),
              bookings: shuffled(staff.bookings, seed + 3),
              busy: shuffled(staff.busy, seed + 4),
              serviceIds: shuffled(staff.serviceIds, seed + 5),
              rules: { ...staff.rules, blackouts: shuffled(staff.rules.blackouts, seed + 6) },
            })),
          };
          const first = availableSlots(query);
          expect(availableSlots(query)).toEqual(first);
          expect(availableSlots(reordered)).toEqual(first);
        }),
        RUNS,
      );
    },
    TIMEOUT_MS,
  );
});
