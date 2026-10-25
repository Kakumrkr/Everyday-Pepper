import type { ClientId, FeedInsightKind, StaffMemberId, UtcDateTime } from '@pepper/contracts';
import { mergeIntervals, type Interval } from '../availability/engine.js';
import {
  addDays,
  formatDate,
  fromZoned,
  isoWeekday,
  toZoned,
  type CivilDate,
} from '../availability/zoned-time.js';
import {
  CLIENT_MEDIAN,
  INSIGHT_HORIZON_DAYS,
  NO_SHOW_PATTERN,
  STAFF_OVERLOAD,
  type InsightBooking,
  type InsightCandidate,
  type InsightProvider,
  type InsightSnapshot,
  type InsightStaff,
} from './types.js';

// The rule-based insight providers (S35, ADR-0039; `waitlist_match` from S38a). Rules find; the model only writes
// drafts later (S36). Every day boundary is the business's local midnight, read through the
// time-zone helpers, so a DST change lengthens or shortens a day in real time and a date
// plus n days is a calendar date, not n × 24 hours.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const utc = (ms: number) => new Date(ms).toISOString() as UtcDateTime;
const localDate = (timeZone: string, instant: number): CivilDate => {
  const { year, month, day } = toZoned(timeZone, instant);
  return { year, month, day };
};
const startOfDay = (timeZone: string, date: CivilDate) => fromZoned(timeZone, date, 0);
/** Whole calendar days from `a` to `b`. */
const daysBetween = (a: CivilDate, b: CivilDate) =>
  Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );

/** The local days the forward-looking providers cover: today and the next six. */
function horizon(snapshot: InsightSnapshot): CivilDate[] {
  const today = localDate(snapshot.timeZone, snapshot.now);
  return Array.from({ length: INSIGHT_HORIZON_DAYS }, (_, i) => addDays(today, i));
}

/** A staff member's working intervals on a local day, net of time off. */
function workingIntervals(timeZone: string, staff: InsightStaff, date: CivilDate): Interval[] {
  const weekday = isoWeekday(date);
  const windows = staff.hours
    .filter((window) => window.weekday === weekday)
    .map((window) => ({
      start: fromZoned(timeZone, date, window.startMinute),
      end:
        window.endMinute >= 1440
          ? startOfDay(timeZone, addDays(date, 1))
          : fromZoned(timeZone, date, window.endMinute),
    }));
  return subtract(mergeIntervals(windows), staff.timeOff);
}

/** `from` minus every interval in `taken` (all half-open). */
function subtract(from: readonly Interval[], taken: readonly Interval[]): Interval[] {
  const blocks = mergeIntervals(taken);
  const result: Interval[] = [];
  for (const interval of from) {
    let start = interval.start;
    for (const block of blocks) {
      if (block.end <= start || block.start >= interval.end) continue;
      if (block.start > start) result.push({ start, end: block.start });
      start = Math.max(start, block.end);
    }
    if (start < interval.end) result.push({ start, end: interval.end });
  }
  return result;
}

const occupies = (booking: InsightBooking) =>
  booking.status === 'confirmed' || booking.status === 'completed';
const occupied = (booking: InsightBooking): Interval => ({
  start: booking.start - booking.bufferBeforeMinutes * MINUTE_MS,
  end: booking.end + booking.bufferAfterMinutes * MINUTE_MS,
});
const minutes = (intervals: readonly Interval[]) =>
  intervals.reduce((sum, interval) => sum + (interval.end - interval.start), 0) / MINUTE_MS;

function bookingsByStaff(snapshot: InsightSnapshot): Map<StaffMemberId, Interval[]> {
  const byStaff = new Map<StaffMemberId, Interval[]>();
  for (const booking of snapshot.bookings) {
    if (!occupies(booking)) continue;
    const list = byStaff.get(booking.staffMemberId) ?? [];
    list.push(occupied(booking));
    byStaff.set(booking.staffMemberId, list);
  }
  return byStaff;
}

/**
 * A staff member's open time on a local day, from now on, inside working hours and at least
 * the business's shortest gap long (`taken`: their occupied intervals, buffers included).
 */
export function openGaps(
  snapshot: InsightSnapshot,
  staff: InsightStaff,
  date: CivilDate,
  taken: readonly Interval[],
): Interval[] {
  const open = subtract(workingIntervals(snapshot.timeZone, staff, date), [
    ...taken,
    { start: Number.MIN_SAFE_INTEGER, end: snapshot.now },
  ]);
  return open.filter((gap) => gap.end - gap.start >= snapshot.minGapMinutes * MINUTE_MS);
}

export { bookingsByStaff, localDate, minutes, occupies, startOfDay };

const NO_SUBJECTS = { staffMemberId: null, clientId: null, bookingId: null, serviceId: null };

/** Open time inside working hours, from now on, at least `minGapMinutes` long. */
export const scheduleGaps: InsightProvider = {
  kind: 'schedule_gaps',
  find(snapshot) {
    const taken = bookingsByStaff(snapshot);
    const items: InsightCandidate[] = [];
    for (const date of horizon(snapshot)) {
      for (const staff of snapshot.staff) {
        if (!staff.active) continue;
        const gaps = openGaps(snapshot, staff, date, taken.get(staff.id) ?? []);
        const last = gaps.at(-1);
        if (last === undefined) continue;
        const longest = gaps.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
        items.push({
          kind: 'schedule_gaps',
          subjectKey: `staff:${staff.id}`,
          day: formatDate(date),
          audienceStaffId: staff.id,
          subjects: { ...NO_SUBJECTS, staffMemberId: staff.id },
          payload: {
            gapCount: gaps.length,
            openMinutes: Math.round(minutes(gaps)),
            longestStartsAt: utc(longest.start),
            longestEndsAt: utc(longest.end),
          },
          expiresAt: last.end,
        });
      }
    }
    return items;
  },
};

/** The median of whole-day intervals, rounded, kept within a week and a year. */
function medianDays(intervals: number[]): number {
  const sorted = [...intervals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  const median = sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
  return Math.min(CLIENT_MEDIAN.maxDays, Math.max(CLIENT_MEDIAN.minDays, Math.round(median)));
}

/** A regular past their usual return date, with nothing booked, until twice the interval. */
export const rebookingDue: InsightProvider = {
  kind: 'rebooking_due',
  find(snapshot) {
    const { now, timeZone } = snapshot;
    const serviceDays = new Map(snapshot.services.map((s) => [s.id, s.rebookAfterDays]));
    const visits = new Map<ClientId, InsightBooking[]>();
    const bookedAhead = new Set<ClientId>();
    for (const booking of snapshot.bookings) {
      if (booking.start >= now) {
        if (booking.status === 'confirmed') bookedAhead.add(booking.clientId);
      } else if (occupies(booking)) {
        const list = visits.get(booking.clientId) ?? [];
        list.push(booking);
        visits.set(booking.clientId, list);
      }
    }
    const today = localDate(timeZone, now);
    const items: InsightCandidate[] = [];
    for (const [clientId, list] of visits) {
      if (bookedAhead.has(clientId)) continue;
      list.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
      const last = list.at(-1);
      if (last === undefined) continue;
      const lastDay = localDate(timeZone, last.start);
      const ownDays = serviceDays.get(last.serviceId) ?? null;
      let intervalDays: number;
      let basis: 'service' | 'client_median';
      if (ownDays !== null) {
        intervalDays = ownDays;
        basis = 'service';
      } else if (list.length >= CLIENT_MEDIAN.minVisits) {
        const days = list.map((visit) => localDate(timeZone, visit.start));
        intervalDays = medianDays(days.slice(1).map((day, i) => daysBetween(days[i] ?? day, day)));
        basis = 'client_median';
      } else {
        continue;
      }
      const dueOn = addDays(lastDay, intervalDays);
      const goneOn = addDays(lastDay, intervalDays * 2);
      if (daysBetween(dueOn, today) < 0 || daysBetween(today, goneOn) <= 0) continue;
      items.push({
        kind: 'rebooking_due',
        subjectKey: `client:${clientId}`,
        day: formatDate(dueOn),
        audienceStaffId: last.staffMemberId,
        subjects: {
          staffMemberId: last.staffMemberId,
          clientId,
          bookingId: last.id,
          serviceId: last.serviceId,
        },
        payload: { lastVisitAt: utc(last.start), intervalDays, basis, dueOn: formatDate(dueOn) },
        expiresAt: startOfDay(timeZone, goneOn),
      });
    }
    return items.sort(
      (a, b) => a.day.localeCompare(b.day) || a.subjectKey.localeCompare(b.subjectKey),
    );
  },
};

/** A client with repeated recent no-shows who is booked again within the horizon. */
export const noShowPattern: InsightProvider = {
  kind: 'no_show_pattern',
  find(snapshot) {
    const { now, timeZone } = snapshot;
    const windowStart = now - NO_SHOW_PATTERN.windowDays * DAY_MS;
    const horizonEnd = startOfDay(
      timeZone,
      addDays(localDate(timeZone, now), INSIGHT_HORIZON_DAYS),
    );
    const noShows = new Map<ClientId, number>();
    const next = new Map<ClientId, InsightBooking>();
    for (const booking of snapshot.bookings) {
      if (booking.status === 'no_show' && booking.start >= windowStart && booking.start < now) {
        noShows.set(booking.clientId, (noShows.get(booking.clientId) ?? 0) + 1);
      } else if (
        booking.status === 'confirmed' &&
        booking.start >= now &&
        booking.start < horizonEnd
      ) {
        const current = next.get(booking.clientId);
        if (current === undefined || booking.start < current.start)
          next.set(booking.clientId, booking);
      }
    }
    const items: InsightCandidate[] = [];
    for (const [clientId, booking] of next) {
      const count = noShows.get(clientId) ?? 0;
      if (count < NO_SHOW_PATTERN.minCount) continue;
      items.push({
        kind: 'no_show_pattern',
        subjectKey: `client:${clientId}`,
        day: formatDate(localDate(timeZone, booking.start)),
        audienceStaffId: null,
        subjects: {
          staffMemberId: booking.staffMemberId,
          clientId,
          bookingId: booking.id,
          serviceId: booking.serviceId,
        },
        payload: {
          noShowCount: count,
          windowDays: NO_SHOW_PATTERN.windowDays,
          bookingStartsAt: utc(booking.start),
        },
        expiresAt: booking.start,
      });
    }
    return items.sort(
      (a, b) => a.day.localeCompare(b.day) || a.subjectKey.localeCompare(b.subjectKey),
    );
  },
};

/** A staff member booked at least 90% of their working time on 3 or more of the next 7 days. */
export const staffOverload: InsightProvider = {
  kind: 'staff_overload',
  find(snapshot) {
    const { timeZone } = snapshot;
    const taken = bookingsByStaff(snapshot);
    const days = horizon(snapshot);
    const items: InsightCandidate[] = [];
    for (const staff of snapshot.staff) {
      if (!staff.active) continue;
      const busy: { date: CivilDate; share: number }[] = [];
      for (const date of days) {
        const working = workingIntervals(timeZone, staff, date);
        const workingMinutes = minutes(working);
        if (workingMinutes === 0) continue;
        const free = subtract(working, taken.get(staff.id) ?? []);
        const share = (workingMinutes - minutes(free)) / workingMinutes;
        if (share >= STAFF_OVERLOAD.share) busy.push({ date, share });
      }
      const first = busy[0];
      const last = busy.at(-1);
      if (busy.length < STAFF_OVERLOAD.minDays || first === undefined || last === undefined)
        continue;
      items.push({
        kind: 'staff_overload',
        subjectKey: `staff:${staff.id}`,
        day: formatDate(first.date),
        audienceStaffId: null,
        subjects: { ...NO_SUBJECTS, staffMemberId: staff.id },
        payload: {
          busyDays: busy.map((day) => formatDate(day.date)),
          horizonDays: INSIGHT_HORIZON_DAYS,
          peakPercent: Math.min(100, Math.floor(Math.max(...busy.map((day) => day.share)) * 100)),
        },
        expiresAt: startOfDay(timeZone, addDays(last.date, 1)),
      });
    }
    return items;
  },
};

/**
 * A freed time the smart waitlist is working on (S38a): its offers waiting for an OK, out, or
 * claimed. For owners and managers and the staff member whose time it is; gone at its start.
 */
export const waitlistMatch: InsightProvider = {
  kind: 'waitlist_match',
  find(snapshot) {
    return snapshot.waitlistMatches
      .filter((match) => match.start > snapshot.now)
      .map((match) => ({
        kind: 'waitlist_match' as const,
        subjectKey: `booking:${match.bookingId}`,
        day: formatDate(localDate(snapshot.timeZone, match.start)),
        audienceStaffId: match.staffMemberId,
        subjects: {
          ...NO_SUBJECTS,
          staffMemberId: match.staffMemberId,
          bookingId: match.bookingId,
        },
        payload: {
          startsAt: utc(match.start),
          endsAt: utc(match.end),
          state: match.state,
          offered: match.offered,
        },
        expiresAt: match.start,
      }));
  },
};

export const INSIGHT_PROVIDERS: readonly InsightProvider[] = [
  scheduleGaps,
  rebookingDue,
  noShowPattern,
  staffOverload,
  waitlistMatch,
];

/** Every enabled provider's candidates, in provider order. */
export function findInsights(
  snapshot: InsightSnapshot,
  enabled: readonly FeedInsightKind[],
): InsightCandidate[] {
  const on = new Set(enabled);
  return INSIGHT_PROVIDERS.filter((provider) => on.has(provider.kind)).flatMap((provider) =>
    provider.find(snapshot),
  );
}
