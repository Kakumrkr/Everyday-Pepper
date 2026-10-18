import { RULE_LIMITS, type ServiceId, type StaffMemberId } from '@pepper/contracts';
import fc from 'fast-check';
import type {
  AvailabilityQuery,
  ExistingBooking,
  Interval,
  StaffAvailability,
  WorkingWindow,
} from './engine.js';
import type { Blackout, ResolvedRules } from './resolve-rules.js';

// fast-check generators for the availability property tests (ADR-0016). Times cluster around
// US daylight-saving changes so most runs cross or touch one.

/** US time zones with and without DST (Phoenix and Honolulu keep standard time). */
export const US_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

export const SERVICE_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197' as ServiceId;
const OTHER_SERVICE_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819a' as ServiceId;
const STAFF_IDS = [
  '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198',
  '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199',
  '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819b',
] as StaffMemberId[];

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** `true` `weight` times as often as `false`. */
const likely = (weight: number): fc.Arbitrary<boolean> =>
  fc.oneof({ weight, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) });

/** Days of US DST changes (UTC noon) and an ordinary day, as anchors for `now`. */
const ANCHORS = [
  '2026-03-08T12:00:00Z',
  '2026-11-01T12:00:00Z',
  '2027-03-14T12:00:00Z',
  '2027-11-07T12:00:00Z',
  '2026-10-15T12:00:00Z',
].map((iso) => Date.parse(iso));

/**
 * An instant within three days of an anchor: often on a 5-minute mark (so slots land exactly on
 * the notice and advance limits), otherwise at any millisecond.
 */
const instantArb = fc
  .tuple(
    fc.constantFrom(...ANCHORS),
    fc.oneof(
      fc.integer({ min: -3 * DAY_MS, max: 3 * DAY_MS }),
      fc.integer({ min: -3 * 288, max: 3 * 288 }).map((marks) => marks * 5 * MINUTE_MS),
    ),
  )
  .map(([anchor, offset]) => anchor + offset);

/** One day's working intervals: sorted, non-overlapping, on 5-minute marks, up to 24:00. */
const dayWindowsArb = (weekday: number): fc.Arbitrary<WorkingWindow[]> =>
  fc.uniqueArray(fc.integer({ min: 0, max: 288 }), { maxLength: 6 }).map((marks) => {
    const sorted = [...marks].sort((a, b) => a - b);
    const windows: WorkingWindow[] = [];
    for (let i = 0; i + 1 < sorted.length; i += 2) {
      windows.push({
        weekday,
        startMinute: (sorted[i] ?? 0) * 5,
        endMinute: (sorted[i + 1] ?? 0) * 5,
      });
    }
    return windows;
  });

/** A week of working hours as the contracts allow them (a "busy" day is likely). */
export const weekArb: fc.Arbitrary<WorkingWindow[]> = fc
  .tuple(...[1, 2, 3, 4, 5, 6, 7].map((weekday) => dayWindowsArb(weekday)))
  .map((days) => days.flat());

const intervalNear = (center: number): fc.Arbitrary<Interval> =>
  fc
    .tuple(
      fc.integer({ min: -4 * DAY_MS, max: 4 * DAY_MS }),
      fc.integer({ min: 1, max: 3 * DAY_MS }),
    )
    .map(([offset, length]) => {
      const start = center + Math.round(offset / MINUTE_MS) * MINUTE_MS;
      return {
        start,
        end: start + Math.max(MINUTE_MS, Math.round(length / MINUTE_MS) * MINUTE_MS),
      };
    });

const shortIntervalNear = (center: number): fc.Arbitrary<Interval> =>
  fc
    .tuple(fc.integer({ min: -4 * DAY_MS, max: 4 * DAY_MS }), fc.integer({ min: 1, max: 6 * 60 }))
    .map(([offset, minutes]) => {
      const start = center + Math.round(offset / (5 * MINUTE_MS)) * 5 * MINUTE_MS;
      return { start, end: start + minutes * MINUTE_MS };
    });

const bookingNear = (center: number): fc.Arbitrary<ExistingBooking> =>
  fc
    .tuple(
      shortIntervalNear(center),
      fc.integer({ min: 0, max: 60 }),
      fc.integer({ min: 0, max: 60 }),
    )
    .map(([interval, bufferBeforeMinutes, bufferAfterMinutes]) => ({
      ...interval,
      bufferBeforeMinutes,
      bufferAfterMinutes,
    }));

const localDateNear = (center: number): fc.Arbitrary<string> =>
  fc
    .integer({ min: -3, max: 5 })
    .map((days) => new Date(center + days * DAY_MS).toISOString().slice(0, 10));

const blackoutNear = (center: number): fc.Arbitrary<Blackout> =>
  fc.tuple(localDateNear(center), fc.integer({ min: 0, max: 2 })).map(([startDate, days]) => ({
    startDate,
    endDate: new Date(Date.parse(`${startDate}T00:00:00Z`) + days * DAY_MS)
      .toISOString()
      .slice(0, 10),
  }));

const rulesNear = (center: number): fc.Arbitrary<ResolvedRules> =>
  fc.record({
    slotIntervalMinutes: fc.constantFrom(...RULE_LIMITS.slotIntervalMinutes),
    minimumNoticeMinutes: fc.oneof(
      fc.constant(0),
      fc.integer({ min: 0, max: 3 * 24 * 60 }),
      fc.integer({ min: 0, max: 3 * 24 * 12 }).map((marks) => marks * 5),
    ),
    maximumAdvanceDays: fc.integer({ min: 1, max: 10 }),
    maxBookingsPerDay: fc.option(fc.integer({ min: 1, max: 4 }), { nil: null }),
    blackouts: fc.array(blackoutNear(center), { maxLength: 2 }),
  });

const staffNear = (center: number, staffMemberId: StaffMemberId): fc.Arbitrary<StaffAvailability> =>
  fc.record({
    staffMemberId: fc.constant(staffMemberId),
    active: likely(9),
    serviceIds: fc.oneof(
      { weight: 9, arbitrary: fc.constant([OTHER_SERVICE_ID, SERVICE_ID]) },
      { weight: 1, arbitrary: fc.constant([OTHER_SERVICE_ID]) },
    ),
    hours: weekArb,
    timeOff: fc.array(intervalNear(center), { maxLength: 2 }),
    bookings: fc.array(bookingNear(center), { maxLength: 8 }),
    busy: fc.array(shortIntervalNear(center), { maxLength: 3 }),
    rules: rulesNear(center),
  });

/** A whole availability question: up to three staff members, a range of up to 4 days. */
export const queryArb: fc.Arbitrary<AvailabilityQuery> = instantArb.chain((now) =>
  fc
    .record({
      timeZone: fc.constantFrom(...US_TIME_ZONES),
      now: fc.constant(now),
      from: fc.integer({ min: -DAY_MS, max: 2 * DAY_MS }).map((offset) => now + offset),
      to: fc.constant(0),
      rangeLength: fc.integer({ min: 0, max: 4 * DAY_MS }),
      service: fc.record({
        id: fc.constant(SERVICE_ID),
        active: likely(19),
        durationMinutes: fc.integer({ min: RULE_LIMITS.slotIntervalMinutes[0], max: 300 }),
        bufferBeforeMinutes: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 })),
        bufferAfterMinutes: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 60 })),
      }),
      staff: fc
        .subarray(STAFF_IDS, { minLength: 1 })
        .chain((ids) => fc.tuple(...ids.map((id) => staffNear(now, id)))),
    })
    .map(({ rangeLength, ...query }) => ({ ...query, to: query.from + rangeLength })),
);
