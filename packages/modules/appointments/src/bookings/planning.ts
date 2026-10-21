import {
  AvailableSlotSchema,
  minutesOfDay,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type AvailableSlot,
  type Rule,
  type RuleDefaults,
  type WaitlistWindow,
} from '@pepper/contracts';
import type { Occupancy, StaffMemberRecord, TimeOffRow, WorkingMinutes } from '@pepper/db';
import type { ExistingBooking, Slot, StaffAvailability } from '../availability/engine.js';
import { resolveRules } from '../availability/resolve-rules.js';
import { fromZoned, parseDate } from '../availability/zoned-time.js';

// The pure parts of booking (ADR-0017): turning stored rows into the availability engine's
// inputs, choosing alternatives for a refused time, and when a waitlist entry expires. The
// services load the rows inside a transaction and call these.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * How far before and after a query's range to load bookings and time off. The engine needs
 * every booking that starts on a local day the range touches (daily cap) and every busy time
 * a slot's buffers may reach; a local day is at most 25 hours and buffers at most 4 hours.
 */
export const LOAD_MARGIN_MS = 2 * DAY_MS;

/** How many days before and after a refused time to look for alternatives. */
export const ALTERNATIVES_SEARCH_DAYS = 7;

/** An active booking's occupied time as the engine reads it: appointment plus buffers. */
export function existingBookingOf(occupancy: Occupancy): ExistingBooking {
  const start = occupancy.startsAt.getTime();
  const end = occupancy.endsAt.getTime();
  return {
    start,
    end,
    bufferBeforeMinutes: (start - occupancy.occupiedFrom.getTime()) / MINUTE_MS,
    bufferAfterMinutes: (occupancy.occupiedTo.getTime() - end) / MINUTE_MS,
  };
}

export interface StaffRows {
  staff: Pick<StaffMemberRecord, 'id' | 'active' | 'serviceIds'>;
  /** Working hours, time off and occupancy of any staff members; this one's are picked. */
  hours: readonly (WorkingMinutes & { staffMemberId: string })[];
  timeOff: readonly TimeOffRow[];
  occupancy: readonly Occupancy[];
  /** The business's whole rule set. */
  rules: readonly Rule[];
  templateDefaults?: Partial<RuleDefaults>;
  /** A booking being moved: its own time does not block the move. */
  excludeBookingId?: string;
}

/** One staff member's input to the availability engine. */
export function staffAvailabilityOf(rows: StaffRows): StaffAvailability {
  const { staff } = rows;
  const staffMemberId = StaffMemberIdSchema.parse(staff.id);
  return {
    staffMemberId,
    active: staff.active,
    serviceIds: staff.serviceIds.map((id) => ServiceIdSchema.parse(id)),
    hours: rows.hours
      .filter((h) => h.staffMemberId === staff.id)
      .map(({ weekday, startMinute, endMinute }) => ({ weekday, startMinute, endMinute })),
    timeOff: rows.timeOff
      .filter((t) => t.staffMemberId === staff.id)
      .map((t) => ({ start: t.startsAt.getTime(), end: t.endsAt.getTime() })),
    bookings: rows.occupancy
      .filter((o) => o.staffMemberId === staff.id && o.bookingId !== rows.excludeBookingId)
      .map(existingBookingOf),
    // Outside calendars come with Google Calendar sync (Phase 10).
    busy: [],
    rules: resolveRules(rows.rules, staffMemberId, rows.templateDefaults),
  };
}

/** The range to search for alternatives to a time: a week either side, not before `now`. */
export function alternativesRange(around: number, now: number): { from: number; to: number } {
  return {
    from: Math.max(now, around - ALTERNATIVES_SEARCH_DAYS * DAY_MS),
    // A time long past: the week ahead of now, never an inverted (invalid) range.
    to: Math.max(around, now) + ALTERNATIVES_SEARCH_DAYS * DAY_MS,
  };
}

/** The `count` slots nearest to `around`, nearest first (earlier first on a tie). */
export function nearestSlots(slots: readonly Slot[], around: number, count: number): Slot[] {
  return [...slots]
    .sort((a, b) => Math.abs(a.start - around) - Math.abs(b.start - around) || a.start - b.start)
    .slice(0, count);
}

export function toAvailableSlot(slot: Slot): AvailableSlot {
  return AvailableSlotSchema.parse({
    staffMemberId: slot.staffMemberId,
    startsAt: new Date(slot.start).toISOString(),
    endsAt: new Date(slot.end).toISOString(),
  });
}

/** When a waitlist entry expires: the end of its last window, in the business's time zone. */
export function waitlistExpiry(windows: readonly WaitlistWindow[], timeZone: string): number {
  if (windows.length === 0) throw new RangeError('A waitlist entry needs at least one window');
  return Math.max(
    ...windows.map((w) => fromZoned(timeZone, parseDate(w.date), minutesOfDay(w.end))),
  );
}
