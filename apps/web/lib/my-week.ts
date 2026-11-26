import {
  addDays,
  fromZoned,
  type CivilDate,
  type StaffMember,
  type WorkingInterval,
} from '@pepper/contracts';
import type { Timed } from './calendar';
import { weekdayHeading, workingSpans } from './calendar-week';

// "My week" (S72.2, AC-X-189…192): a staff member's own Monday to Sunday as a list, day by day,
// for a phone. Everything here is pure; the page loads the week (the week view's loader) and
// draws it.

/** The member's own place on the calendar: an active staff member linked to their login. */
export function ownStaffMember(staff: readonly StaffMember[], userId: string): StaffMember | null {
  return staff.find((member) => member.active && member.userId === userId) ?? null;
}

export interface MyWeekDay<T extends Timed> {
  date: CivilDate;
  /** When they work that day, in order; empty on a day off (or with the hours unknown). */
  working: Timed[];
  /** Off all day: no working hours, or time off over all of them. Never with the hours unknown. */
  off: boolean;
  /** Their time off that day, clipped to it. */
  timeOff: Timed[];
  /** Busy in their Google Calendar that day, clipped to it. */
  outside: Timed[];
  /** Their visits starting that day, earliest first. */
  visits: T[];
}

function clipped(spans: readonly Timed[], from: number, to: number): Timed[] {
  return spans.flatMap((span) => {
    const start = Math.max(Date.parse(span.startsAt), from);
    const end = Math.min(Date.parse(span.endsAt), to);
    return start < end
      ? [{ startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }]
      : [];
  });
}

/** Whether `cover` covers every moment of `spans`. */
function covers(cover: readonly Timed[], spans: readonly Timed[]): boolean {
  return spans.every((span) => {
    let cursor = Date.parse(span.startsAt);
    const end = Date.parse(span.endsAt);
    for (const away of [...cover].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
      if (Date.parse(away.startsAt) > cursor) break;
      cursor = Math.max(cursor, Date.parse(away.endsAt));
      if (cursor >= end) return true;
    }
    return cursor >= end;
  });
}

/** The week's days with what each holds, on the business's clock. */
export function myWeekDays<T extends Timed>(
  timeZone: string,
  dates: readonly CivilDate[],
  week: {
    visits: readonly T[];
    hours: readonly WorkingInterval[] | null;
    timeOff: readonly Timed[];
    outside: readonly Timed[];
  },
): MyWeekDay<T>[] {
  return dates.map((date) => {
    const from = fromZoned(timeZone, date, 0);
    const to = fromZoned(timeZone, addDays(date, 1), 0);
    const working = week.hours === null ? [] : workingSpans(timeZone, [date], week.hours);
    const timeOff = clipped(week.timeOff, from, to);
    return {
      date,
      working,
      off: week.hours !== null && (working.length === 0 || covers(timeOff, working)),
      timeOff,
      outside: clipped(week.outside, from, to),
      visits: week.visits
        .filter((visit) => {
          const start = Date.parse(visit.startsAt);
          return start >= from && start < to;
        })
        .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
    };
  });
}

/** `8 h 30`, `45 min`, `2 h`. */
export function bookedTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest).padStart(2, '0')}`;
}

/**
 * The header's line (AC-X-191): `11 visits · 8 h 30 booked · Sat, Sun off`, from the visits
 * shown (cancelled ones are already left out); no money.
 */
export function myWeekSummary(days: readonly MyWeekDay<Timed>[]): string {
  const visits = days.flatMap((day) => day.visits);
  const minutes = Math.round(
    visits.reduce(
      (sum, visit) => sum + (Date.parse(visit.endsAt) - Date.parse(visit.startsAt)) / 60_000,
      0,
    ),
  );
  const off = days.filter((day) => day.off).map((day) => weekdayHeading(day.date).weekday);
  return [
    visits.length === 0
      ? 'No visits'
      : `${String(visits.length)} ${visits.length === 1 ? 'visit' : 'visits'}`,
    ...(visits.length === 0 ? [] : [`${bookedTime(minutes)} booked`]),
    ...(off.length === 0 ? [] : [`${off.join(', ')} off`]),
  ].join(' · ');
}
