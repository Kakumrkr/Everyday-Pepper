import type { DailyBriefingPayload, StaffMemberId, UtcDateTime } from '@pepper/contracts';
import type { Interval } from '../availability/engine.js';
import { addDays, formatDate, isoWeekday } from '../availability/zoned-time.js';
import {
  bookingsByStaff,
  localDate,
  minutes,
  occupies,
  openGaps,
  startOfDay,
} from './providers.js';
import type { InsightSnapshot } from './types.js';

// The daily briefing's numbers (S38a, ADR-0042): a pure function of the business's snapshot,
// like the insight providers. One briefing for the business (owners and managers) and one for
// each staff member's own day; ids and numbers only, the words are a template's (`feedLine`).

/** What the briefing needs beyond the snapshot, read in the same transaction. */
export interface BriefingContext {
  /** Staff members who get their own day (linked to a member with the staff role). */
  ownDayStaff: readonly StaffMemberId[];
  needsOk: number;
  rebookingDue: number;
  waitlist: { waiting: number; offered: number; claimed: number };
}

/** A briefing to write: the business's (`staffMemberId` null) or one staff member's. */
export interface BriefingDraft {
  staffMemberId: StaffMemberId | null;
  /** The local day (`YYYY-MM-DD`). */
  day: string;
  payload: DailyBriefingPayload;
  /** The end of that local day (epoch ms). */
  expiresAt: number;
}

const utc = (ms: number) => new Date(ms).toISOString() as UtcDateTime;

/** Today's briefings for the business at `snapshot.now`, in its time zone. */
export function buildBriefings(
  snapshot: InsightSnapshot,
  context: BriefingContext,
): BriefingDraft[] {
  const today = localDate(snapshot.timeZone, snapshot.now);
  const from = startOfDay(snapshot.timeZone, today);
  const to = startOfDay(snapshot.timeZone, addDays(today, 1));
  const taken = bookingsByStaff(snapshot);
  const todays = snapshot.bookings.filter(
    (booking) => occupies(booking) && booking.start >= from && booking.start < to,
  );
  const dayOf = (staffId: StaffMemberId | null) => {
    const bookings = todays.filter(
      (booking) => staffId === null || booking.staffMemberId === staffId,
    );
    const gaps: Interval[] = snapshot.staff
      .filter((staff) => staff.active && (staffId === null || staff.id === staffId))
      .flatMap((staff) => openGaps(snapshot, staff, today, taken.get(staff.id) ?? []));
    const first = bookings.reduce<number | null>(
      (earliest, booking) =>
        earliest === null ? booking.start : Math.min(earliest, booking.start),
      null,
    );
    return {
      bookingCount: bookings.length,
      firstStartsAt: first === null ? null : utc(first),
      gapCount: gaps.length,
      openMinutes: Math.round(minutes(gaps)),
    };
  };

  const day = formatDate(today);
  const briefings: BriefingDraft[] = [
    {
      staffMemberId: null,
      day,
      payload: {
        scope: 'business',
        ...dayOf(null),
        needsOkCount: context.needsOk,
        rebookingDueCount: context.rebookingDue,
        waitlistWaiting: context.waitlist.waiting,
        waitlistOffered: context.waitlist.offered,
        waitlistClaimed: context.waitlist.claimed,
      },
      expiresAt: to,
    },
  ];
  const weekday = isoWeekday(today);
  const own = new Set(context.ownDayStaff);
  for (const staff of snapshot.staff) {
    if (!staff.active || !own.has(staff.id)) continue;
    const numbers = dayOf(staff.id);
    // A day off (no hours today and nothing booked) gets no briefing.
    const works = staff.hours.some((window) => window.weekday === weekday);
    if (!works && numbers.bookingCount === 0) continue;
    briefings.push({
      staffMemberId: staff.id,
      day,
      payload: {
        scope: 'staff',
        ...numbers,
        needsOkCount: null,
        rebookingDueCount: null,
        waitlistWaiting: null,
        waitlistOffered: null,
        waitlistClaimed: null,
      },
      expiresAt: to,
    });
  }
  return briefings;
}
