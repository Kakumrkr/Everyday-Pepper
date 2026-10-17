import type { ServiceId, StaffMemberId } from '@floty/contracts';
import type { ResolvedRules } from './resolve-rules.js';
import {
  addDays,
  formatDate,
  fromZoned,
  isoWeekday,
  toZoned,
  type CivilDate,
} from './zoned-time.js';

// The availability engine (ADR-0016): a pure, deterministic function from a staff member's
// weekly hours, time off, bookings, outside busy time and rules to the start times a service
// can be booked at. No clock, no database: the caller passes `now` and the data. All instants
// are epoch milliseconds (UTC) and all intervals are half-open, [start, end).
//
// A slot is offered when:
// - the service is active, and the staff member is active and offers it;
// - the appointment itself fits inside one working interval, read in the business's time zone
//   on that day (DST changes lengthen or shorten the interval in real time);
// - its start lies on the interval's grid (start + k × slot interval), and in [from, to);
// - the time it occupies (the appointment with the service's buffers before and after, which
//   may reach outside working hours) overlaps no time off, no outside busy time and no other
//   booking's occupied time (its own buffers included);
// - it starts at least the minimum notice after `now` and less than the maximum advance after;
// - its local day is not blacked out and has fewer bookings than the daily cap.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The longest range one call may ask about. */
export const MAX_AVAILABILITY_RANGE_DAYS = 62;

/** A span of time, [start, end) in epoch milliseconds. */
export interface Interval {
  start: number;
  end: number;
}

/** One weekly working interval in minutes after local midnight (as stored, ADR-0015). */
export interface WorkingWindow {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  startMinute: number;
  /** Up to 1440 (midnight at the end of the day). */
  endMinute: number;
}

/** A booking the staff member already has: the appointment and its service's buffers. */
export interface ExistingBooking extends Interval {
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

/** The service being booked. */
export interface ServiceToBook {
  id: ServiceId;
  active: boolean;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

/**
 * One staff member who might take the booking. `bookings` must include every booking that
 * starts on a local day the range touches, so the daily cap is counted correctly.
 */
export interface StaffAvailability {
  staffMemberId: StaffMemberId;
  active: boolean;
  serviceIds: readonly ServiceId[];
  hours: readonly WorkingWindow[];
  timeOff: readonly Interval[];
  bookings: readonly ExistingBooking[];
  /** Busy time from outside calendars (Google Calendar, Phase 4). */
  busy: readonly Interval[];
  rules: ResolvedRules;
}

export interface AvailabilityQuery {
  /** The business's IANA time zone. */
  timeZone: string;
  now: number;
  /** Offered start times lie in [from, to). */
  from: number;
  to: number;
  service: ServiceToBook;
  staff: readonly StaffAvailability[];
}

/** A bookable start time with one staff member. */
export interface Slot {
  staffMemberId: StaffMemberId;
  start: number;
  /** The appointment's end (without the buffer after). */
  end: number;
}

/** The slots the service can be booked at, by start time and then staff member id. */
export function availableSlots(query: AvailabilityQuery): Slot[] {
  if (query.to - query.from > MAX_AVAILABILITY_RANGE_DAYS * DAY_MS) {
    throw new RangeError(
      `Ask about at most ${String(MAX_AVAILABILITY_RANGE_DAYS)} days of availability at once`,
    );
  }
  if (!query.service.active) return [];
  return query.staff
    .flatMap((staff) => slotsFor(query, staff))
    .sort((a, b) => a.start - b.start || compareIds(a.staffMemberId, b.staffMemberId));
}

function slotsFor(query: AvailabilityQuery, staff: StaffAvailability): Slot[] {
  const { timeZone, service } = query;
  const { rules } = staff;
  if (!staff.active || !staff.serviceIds.includes(service.id)) return [];

  const earliest = Math.max(query.from, query.now + rules.minimumNoticeMinutes * MINUTE_MS);
  const latest = Math.min(query.to, query.now + rules.maximumAdvanceDays * DAY_MS);
  if (earliest >= latest) return [];

  const duration = service.durationMinutes * MINUTE_MS;
  const before = service.bufferBeforeMinutes * MINUTE_MS;
  const after = service.bufferAfterMinutes * MINUTE_MS;
  const step = rules.slotIntervalMinutes * MINUTE_MS;
  // Rules normally come through the contracts; a hand-made step of 0 would never end.
  if (!Number.isInteger(rules.slotIntervalMinutes) || step <= 0) {
    throw new RangeError('The slot interval must be a positive whole number of minutes');
  }
  const blocked = mergeIntervals([
    ...staff.timeOff,
    ...staff.busy,
    ...staff.bookings.map((b) => ({
      start: b.start - b.bufferBeforeMinutes * MINUTE_MS,
      end: b.end + b.bufferAfterMinutes * MINUTE_MS,
    })),
  ]);
  const bookingsPerDay = countByLocalDay(timeZone, staff.bookings);

  const slots: Slot[] = [];
  const lastDay = formatDate(toZoned(timeZone, latest - 1));
  // A slot that starts at or after `earliest` starts on its local day or later.
  for (let day: CivilDate = toZoned(timeZone, earliest); ; day = addDays(day, 1)) {
    const date = formatDate(day);
    if (date > lastDay) break;
    if (isBlackedOut(rules, date)) continue;
    if (
      rules.maxBookingsPerDay !== null &&
      (bookingsPerDay.get(date) ?? 0) >= rules.maxBookingsPerDay
    ) {
      continue;
    }
    const weekday = isoWeekday(day);
    for (const window of staff.hours) {
      if (window.weekday !== weekday) continue;
      const windowStart = fromZoned(timeZone, day, window.startMinute);
      const windowEnd = fromZoned(timeZone, day, window.endMinute);
      const skip = Math.max(0, Math.ceil((earliest - windowStart) / step));
      for (let start = windowStart + skip * step; start + duration <= windowEnd; start += step) {
        if (start >= latest) break;
        if (!overlapsAny(blocked, start - before, start + duration + after)) {
          slots.push({ staffMemberId: staff.staffMemberId, start, end: start + duration });
        }
      }
    }
  }
  return slots;
}

function isBlackedOut(rules: ResolvedRules, date: string): boolean {
  return rules.blackouts.some((b) => b.startDate <= date && date <= b.endDate);
}

function countByLocalDay(timeZone: string, bookings: readonly Interval[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const booking of bookings) {
    const date = formatDate(toZoned(timeZone, booking.start));
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return counts;
}

/** Sorted, non-overlapping intervals covering the same time (touching ones joined). */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end)
      last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Whether [start, end) overlaps any of the sorted, merged `intervals`. */
function overlapsAny(intervals: readonly Interval[], start: number, end: number): boolean {
  // The first interval that ends after `start`.
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((intervals[middle]?.end ?? Infinity) <= start) low = middle + 1;
    else high = middle;
  }
  const candidate = intervals[low];
  return candidate !== undefined && candidate.start < end;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
