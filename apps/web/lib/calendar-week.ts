import {
  addDays,
  fromZoned,
  isoWeekday,
  minutesOfDay,
  type CivilDate,
  type MembershipRole,
  type StaffMember,
  type WorkingInterval,
} from '@pepper/contracts';
import { DEFAULT_DAY_END_MINUTE, DEFAULT_DAY_START_MINUTE, minuteOn, type Timed } from './calendar';

// The calendar's week view (S69): one staff member's Monday-to-Sunday on the business's wall
// clock, where their working hours are, and where a dragged booking would land. Everything here
// is pure; the page loads the data and the grid follows the pointer.

/** The steps a dragged booking moves in, in minutes. */
export const DRAG_STEP_MINUTES = 15;

/** The Monday of `date`'s week: weeks start on Monday, as the working hours do (ISO). */
export function weekStart(date: CivilDate): CivilDate {
  return addDays(date, 1 - isoWeekday(date));
}

/** The seven dates of `date`'s week, Monday first. */
export function weekDates(date: CivilDate): CivilDate[] {
  const monday = weekStart(date);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** The UTC instants of the business's local week [Monday midnight, next Monday midnight). */
export function weekRange(timeZone: string, date: CivilDate): { from: string; to: string } {
  const monday = weekStart(date);
  return {
    from: new Date(fromZoned(timeZone, monday, 0)).toISOString(),
    to: new Date(fromZoned(timeZone, addDays(monday, 7), 0)).toISOString(),
  };
}

function words(date: CivilDate, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(
    Date.UTC(date.year, date.month - 1, date.day),
  );
}

/** `Nov 23 – 29`, `Nov 30 – Dec 6`, with the years when the week isn't all in `today`'s. */
export function weekTitle(date: CivilDate, today: CivilDate): string {
  const first = weekStart(date);
  const last = addDays(first, 6);
  if (first.year !== today.year || last.year !== today.year) {
    if (first.year === last.year && first.month === last.month) {
      return `${words(first, { month: 'short', day: 'numeric' })} – ${String(last.day)}, ${String(last.year)}`;
    }
    const withYear = { month: 'short', day: 'numeric', year: 'numeric' } as const;
    return `${words(first, withYear)} – ${words(last, withYear)}`;
  }
  if (first.month === last.month) {
    return `${words(first, { month: 'short', day: 'numeric' })} – ${String(last.day)}`;
  }
  const short = { month: 'short', day: 'numeric' } as const;
  return `${words(first, short)} – ${words(last, short)}`;
}

/** A day's column heading: `Wed` over `25`, and the whole date for screen readers. */
export function weekdayHeading(date: CivilDate): { weekday: string; day: string; full: string } {
  return {
    weekday: words(date, { weekday: 'short' }),
    day: String(date.day),
    full: words(date, { weekday: 'long', month: 'long', day: 'numeric' }),
  };
}

/**
 * Whose week to show: the one asked for while they are active; otherwise staff see their own
 * (when they have a place on the calendar) and owners and managers the first active member.
 * `null` without anyone active.
 */
export function weekStaffMember(
  staff: readonly StaffMember[],
  staffMemberId: string | null,
  viewer: { role: MembershipRole; userId: string },
): StaffMember | null {
  const active = staff.filter((member) => member.active);
  const asked = active.find((member) => member.id === staffMemberId);
  if (asked !== undefined) return asked;
  const own =
    viewer.role === 'staff' ? active.find((member) => member.userId === viewer.userId) : undefined;
  return own ?? active[0] ?? null;
}

function span(startMs: number, endMs: number): Timed {
  return { startsAt: new Date(startMs).toISOString(), endsAt: new Date(endMs).toISOString() };
}

/** The week's working hours as instants, in order (each interval on its weekday's date). */
export function workingSpans(
  timeZone: string,
  dates: readonly CivilDate[],
  intervals: readonly WorkingInterval[],
): Timed[] {
  return dates.flatMap((date) =>
    intervals
      .filter((interval) => interval.weekday === isoWeekday(date))
      .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start))
      .map((interval) =>
        span(
          fromZoned(timeZone, date, minutesOfDay(interval.start)),
          fromZoned(timeZone, date, minutesOfDay(interval.end)),
        ),
      ),
  );
}

/**
 * When the staff member isn't working, per day of the week: outside their working hours (a
 * day without hours is off all day) and their time off, clipped to each day and merged. With
 * the hours unknown (`null`), nothing is shaded: the api still decides every move.
 */
export function notWorking(
  timeZone: string,
  dates: readonly CivilDate[],
  intervals: readonly WorkingInterval[] | null,
  timeOff: readonly Timed[],
): Timed[][] {
  if (intervals === null) return dates.map(() => []);
  return dates.map((date) => {
    const dayStart = fromZoned(timeZone, date, 0);
    const dayEnd = fromZoned(timeZone, addDays(date, 1), 0);
    const off: [number, number][] = [];
    let cursor = dayStart;
    for (const working of workingSpans(timeZone, [date], intervals)) {
      const start = Date.parse(working.startsAt);
      if (start > cursor) off.push([cursor, start]);
      cursor = Math.max(cursor, Date.parse(working.endsAt));
    }
    if (cursor < dayEnd) off.push([cursor, dayEnd]);
    for (const away of timeOff) {
      const start = Math.max(Date.parse(away.startsAt), dayStart);
      const end = Math.min(Date.parse(away.endsAt), dayEnd);
      if (start < end) off.push([start, end]);
    }
    off.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [start, end] of off) {
      const last = merged.at(-1);
      if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged.map(([start, end]) => span(start, end));
  });
}

export interface WeekDayLayout<T> {
  date: CivilDate;
  /** Each item on this day, with its top and height as percentages of the grid. */
  blocks: { item: T; top: number; height: number }[];
  /** The not-working shading on this day, clipped to the grid. */
  shade: { top: number; height: number }[];
}

export interface WeekLayout<T> {
  /** The first and last minute of the grid, on whole hours, the same for every day. */
  startMinute: number;
  endMinute: number;
  /** The hour lines, as minutes after midnight. */
  hours: number[];
  days: WeekDayLayout<T>[];
}

function onDay(
  timeZone: string,
  date: CivilDate,
  item: Timed,
): { start: number; end: number } | null {
  const dayStart = fromZoned(timeZone, date, 0);
  const dayEnd = fromZoned(timeZone, addDays(date, 1), 0);
  const start = Date.parse(item.startsAt);
  const end = Date.parse(item.endsAt);
  if (start >= dayEnd || end <= dayStart) return null;
  return { start: minuteOn(timeZone, date, start), end: minuteOn(timeZone, date, end) };
}

/**
 * Where the items sit on the week's grid: one range of hours for all seven days, 8 am – 8 pm
 * widened to whole hours to fit every item and the working hours (`fit`); an item across
 * midnight shows on both days. `shade` (the not-working times) is clipped to that range.
 */
export function layoutWeek<T extends Timed>(
  timeZone: string,
  dates: readonly CivilDate[],
  items: readonly T[],
  fit: readonly Timed[] = [],
  shade: readonly Timed[] = [],
): WeekLayout<T> {
  const spans = [...items, ...fit].flatMap((item) =>
    dates.flatMap((date) => onDay(timeZone, date, item) ?? []),
  );
  const startMinute =
    Math.floor(Math.min(DEFAULT_DAY_START_MINUTE, ...spans.map((s) => s.start)) / 60) * 60;
  const endMinute =
    Math.ceil(Math.max(DEFAULT_DAY_END_MINUTE, ...spans.map((s) => s.end)) / 60) * 60;
  const length = endMinute - startMinute;
  const place = (start: number, end: number) => {
    const top = Math.max(start, startMinute);
    const bottom = Math.min(end, endMinute);
    return {
      top: ((top - startMinute) / length) * 100,
      height: (Math.max(bottom - top, 0) / length) * 100,
    };
  };
  const hours: number[] = [];
  for (let minute = startMinute; minute < endMinute; minute += 60) hours.push(minute);
  return {
    startMinute,
    endMinute,
    hours,
    days: dates.map((date) => ({
      date,
      blocks: items.flatMap((item) => {
        const at = onDay(timeZone, date, item);
        return at === null ? [] : [{ item, ...place(at.start, at.end) }];
      }),
      shade: shade.flatMap((item) => {
        const at = onDay(timeZone, date, item);
        if (at === null) return [];
        const placed = place(at.start, at.end);
        return placed.height > 0 ? [placed] : [];
      }),
    })),
  };
}

/**
 * Where `items` sit on `date`'s column of an already laid-out grid (S70: Google busy times),
 * clipped to its hours like the shading, so they never widen the grid: an all-day block stays
 * inside the day's hours. Each keeps its item, for its times.
 */
export function placedOn<T extends Timed>(
  timeZone: string,
  layout: Pick<WeekLayout<unknown>, 'startMinute' | 'endMinute'>,
  date: CivilDate,
  items: readonly T[],
): { item: T; top: number; height: number }[] {
  const length = layout.endMinute - layout.startMinute;
  return items.flatMap((item) => {
    const at = onDay(timeZone, date, item);
    if (at === null) return [];
    const top = Math.max(at.start, layout.startMinute);
    const bottom = Math.min(at.end, layout.endMinute);
    if (bottom <= top) return [];
    return [
      {
        item,
        top: ((top - layout.startMinute) / length) * 100,
        height: ((bottom - top) / length) * 100,
      },
    ];
  });
}

/**
 * Where a line for `instant` (the now-line) sits on `date`'s column of a laid-out grid, as a
 * percentage of its height; `null` when the instant falls outside the grid's hours. Placed with
 * the grid's own range, so the line meets the blocks beside it.
 */
export function lineAt(
  timeZone: string,
  date: CivilDate,
  instant: string,
  layout: Pick<WeekLayout<Timed>, 'startMinute' | 'endMinute'>,
): number | null {
  const minute = minuteOn(timeZone, date, Date.parse(instant));
  if (minute < layout.startMinute || minute > layout.endMinute) return null;
  return ((minute - layout.startMinute) / (layout.endMinute - layout.startMinute)) * 100;
}

/**
 * The minute at a point of the grid (`ratio`: 0 at its top, 1 at its bottom), in steps of
 * `step` minutes, kept on the grid.
 */
export function minuteAt(
  ratio: number,
  startMinute: number,
  endMinute: number,
  step = DRAG_STEP_MINUTES,
): number {
  const raw = startMinute + ratio * (endMinute - startMinute);
  const snapped = Math.round(raw / step) * step;
  return Math.min(Math.max(snapped, startMinute), endMinute);
}

/** A start minute that keeps a visit of `minutes` wholly on the grid. */
export function clampStart(
  minute: number,
  minutes: number,
  startMinute: number,
  endMinute: number,
): number {
  return Math.max(startMinute, Math.min(minute, endMinute - minutes));
}

/** The instant (ISO) the business's clock shows `minuteOfDay` on `date`. */
export function startAt(timeZone: string, date: CivilDate, minuteOfDay: number): string {
  return new Date(fromZoned(timeZone, date, minuteOfDay)).toISOString();
}

/** `Tue 3:15 PM` on the business's clock: where a dragged booking would land. */
export function dropLabel(timeZone: string, instant: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((piece) => piece.type === type)?.value ?? '';
  return `${part('weekday')} ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/** Why a dragged booking can't go where it is (a hint: the api decides). */
export type DropProblem = 'past' | 'taken' | 'google' | 'off';

/** What the dragged block says about a problem. */
export const DROP_PROBLEM_WORDS: Record<DropProblem, string> = {
  past: 'In the past',
  taken: 'Booked then',
  google: 'Busy in Google Calendar',
  off: 'Not working then',
};

function overlaps(a: Timed, b: Timed): boolean {
  return (
    Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt)
  );
}

/**
 * Whether a dragged booking would land on a problem, before it is dropped: in the past, over
 * another of the staff member's bookings (`bookings`, the dragged one left out), busy in their
 * Google Calendar (`outside`, S70), or outside their working hours or in time off (`off`).
 * `null` when it looks free. Only a hint: buffers, booking rules and changes since the page
 * loaded are the api's to check.
 */
export function dropProblem(
  target: Timed,
  around: {
    bookings: readonly Timed[];
    off: readonly Timed[];
    outside?: readonly Timed[];
    now: number;
  },
): DropProblem | null {
  if (Date.parse(target.startsAt) < around.now) return 'past';
  if (around.bookings.some((booking) => overlaps(target, booking))) return 'taken';
  if ((around.outside ?? []).some((busy) => overlaps(target, busy))) return 'google';
  if (around.off.some((off) => overlaps(target, off))) return 'off';
  return null;
}
