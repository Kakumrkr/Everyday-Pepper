import type { BookingId, ClientId, ServiceId, StaffMemberId } from '@pepper/contracts';
import type { WorkingWindow } from '../availability/engine.js';
import type { InsightBooking, InsightSnapshot, InsightStaff } from './types.js';

// Shared fixtures for the insight providers (S35): a small business in a chosen time zone,
// with helpers that read like the calendar ("Monday 9–17", "a booking at 12:00 local").
// Time zones on both sides of UTC: New York (with both 2026 DST changes: spring forward on
// Sunday 2026-03-08 at 2:00, fall back on Sunday 2026-11-01 at 2:00), Phoenix (no DST) and
// Kolkata (UTC+5:30, so its local day starts at 18:30 UTC the day before).

export const NY = 'America/New_York';
export const PHOENIX = 'America/Phoenix';
export const KOLKATA = 'Asia/Kolkata';

export const JESS = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001' as StaffMemberId;
export const ANA = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700002' as StaffMemberId;
export const MARIA = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700011' as ClientId;
export const SAM = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700012' as ClientId;
export const COLOR = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700021' as ServiceId;
export const CUT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700022' as ServiceId;

export const at = (iso: string): number => Date.parse(iso);

/** Working hours on the given ISO weekdays (1 = Monday), in local hours. */
export function hours(
  weekdays: readonly number[],
  startHour: number,
  endHour: number,
): WorkingWindow[] {
  return weekdays.map((weekday) => ({
    weekday,
    startMinute: startHour * 60,
    endMinute: endHour * 60,
  }));
}

export const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

export function staffMember(
  id: StaffMemberId,
  overrides: Partial<InsightStaff> = {},
): InsightStaff {
  return { id, active: true, hours: hours(EVERY_DAY, 9, 17), timeOff: [], ...overrides };
}

let bookingSeq = 0;

/** A booking from UTC instants; ids are unique within a test run. */
export function booking(
  start: string,
  end: string,
  overrides: Partial<InsightBooking> = {},
): InsightBooking {
  bookingSeq += 1;
  return {
    id: `0199f0a4-7c1e-7d2a-9b3c-${String(bookingSeq).padStart(12, '0')}` as BookingId,
    clientId: MARIA,
    serviceId: CUT,
    staffMemberId: JESS,
    start: at(start),
    end: at(end),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    status: 'confirmed',
    ...overrides,
  };
}

export function snapshot(overrides: Partial<InsightSnapshot> & { now: number }): InsightSnapshot {
  return {
    timeZone: NY,
    minGapMinutes: 60,
    staff: [staffMember(JESS)],
    bookings: [],
    services: [
      { id: COLOR, rebookAfterDays: 42 },
      { id: CUT, rebookAfterDays: null },
    ],
    ...overrides,
  };
}
