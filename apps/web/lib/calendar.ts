import {
  addDays,
  formatDate,
  fromZoned,
  parseDate,
  toZoned,
  type CivilDate,
  type StaffMember,
} from '@floty/contracts';

// The calendar day view (S14): which day and staff to show, and where each appointment sits
// on the business's wall clock. Everything here is pure; the page loads the data.

const DAY_MINUTES = 1440;
/** The hours shown when the day has nothing earlier or later (8 am – 8 pm). */
export const DEFAULT_DAY_START_MINUTE = 8 * 60;
export const DEFAULT_DAY_END_MINUTE = 20 * 60;

export interface CalendarParams {
  date: CivilDate;
  /** Show only this staff member; `null` for everyone. */
  staffMemberId: string | null;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Today's date on the business's clock. */
export function todayIn(timeZone: string, now: number): CivilDate {
  const { year, month, day } = toZoned(timeZone, now);
  return { year, month, day };
}

/** A real calendar date for `YYYY-MM-DD` (years 2000–2100), or `null`. */
export function readDate(text: string | undefined): CivilDate | null {
  if (text === undefined || !DATE_PATTERN.test(text)) return null;
  const date = parseDate(text);
  if (date.year < 2000 || date.year > 2100) return null;
  // Rejects 2026-02-30 and the like: it would roll over to another day.
  return formatDate(addDays(date, 0)) === text ? date : null;
}

/** The day and staff filter from the page's query (`?date=YYYY-MM-DD&staff=<id>`). */
export function readCalendarParams(
  query: Record<string, string | string[] | undefined>,
  today: CivilDate,
): CalendarParams {
  const single = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;
  const staff = single(query['staff']);
  return {
    date: readDate(single(query['date'])) ?? today,
    staffMemberId: staff !== undefined && UUID_PATTERN.test(staff) ? staff.toLowerCase() : null,
  };
}

/** The calendar page's address for a day and staff filter. */
export function calendarHref(date: CivilDate, staffMemberId: string | null): string {
  const query = new URLSearchParams({ date: formatDate(date) });
  if (staffMemberId !== null) query.set('staff', staffMemberId);
  return `/calendar?${query.toString()}`;
}

/** The UTC instants of the business's local day [midnight, next midnight), for api queries. */
export function dayRange(timeZone: string, date: CivilDate): { from: string; to: string } {
  return {
    from: new Date(fromZoned(timeZone, date, 0)).toISOString(),
    to: new Date(fromZoned(timeZone, addDays(date, 1), 0)).toISOString(),
  };
}

/** The staff members to show as columns: active ones, or only the chosen one. */
export function columnsFor(
  staff: readonly StaffMember[],
  staffMemberId: string | null,
): StaffMember[] {
  return staff.filter((member) =>
    staffMemberId === null ? member.active : member.id === staffMemberId,
  );
}

/** Something on the calendar with a time (a booking, or a colleague's busy time). */
export interface Timed {
  startsAt: string;
  endsAt: string;
}

/**
 * Where `instant` falls on the wall clock of `date`, in minutes (0–1440): the grid's hour lines
 * are wall-clock hours, so a clock-change day keeps 10 am on the 10 am line. Before the day is
 * 0, after it 1440.
 */
function minuteOn(timeZone: string, date: CivilDate, instant: number): number {
  const local = toZoned(timeZone, instant);
  const order = formatDate(local).localeCompare(formatDate(date));
  if (order < 0) return 0;
  if (order > 0) return DAY_MINUTES;
  return local.minuteOfDay;
}

export interface DayLayout<T> {
  /** The first and last minute of the grid, on whole hours. */
  startMinute: number;
  endMinute: number;
  /** The hour lines, as minutes after midnight. */
  hours: number[];
  /** Each item with its top and height as percentages of the grid. */
  blocks: { item: T; top: number; height: number }[];
}

/**
 * Where the items sit on the day's grid: 8 am – 8 pm, widened to whole hours to fit every item
 * (also one crossing midnight, clipped to the day).
 */
export function layoutDay<T extends Timed>(
  timeZone: string,
  date: CivilDate,
  items: readonly T[],
): DayLayout<T> {
  const spans = items.map((item) => ({
    item,
    start: minuteOn(timeZone, date, Date.parse(item.startsAt)),
    end: minuteOn(timeZone, date, Date.parse(item.endsAt)),
  }));
  const startMinute =
    Math.floor(Math.min(DEFAULT_DAY_START_MINUTE, ...spans.map((s) => s.start)) / 60) * 60;
  const endMinute =
    Math.ceil(Math.max(DEFAULT_DAY_END_MINUTE, ...spans.map((s) => s.end)) / 60) * 60;
  const length = endMinute - startMinute;
  const hours: number[] = [];
  for (let minute = startMinute; minute < endMinute; minute += 60) hours.push(minute);
  return {
    startMinute,
    endMinute,
    hours,
    blocks: spans.map(({ item, start, end }) => ({
      item,
      top: ((start - startMinute) / length) * 100,
      height: (Math.max(end - start, 0) / length) * 100,
    })),
  };
}

/** `9 AM`, `12 PM` for an hour line. */
export function hourLabel(minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60) % 24;
  return `${String(hour % 12 === 0 ? 12 : hour % 12)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** `9:00 – 10:30 AM` on the business's clock. */
export function timeRange(timeZone: string, startsAt: string, endsAt: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).formatRange(new Date(startsAt), new Date(endsAt));
}

/** `Tuesday, November 3` (with the year when it is not `today`'s). */
export function dayTitle(date: CivilDate, today: CivilDate): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    ...(date.year !== today.year && { year: 'numeric' }),
  }).format(Date.UTC(date.year, date.month - 1, date.day));
}

/** Whether two calendar dates are the same day. */
export function sameDate(a: CivilDate, b: CivilDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export { addDays, formatDate };
