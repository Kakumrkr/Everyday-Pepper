// Wall-clock time in a business's time zone ↔ UTC instants (ADR-0016), with the platform's
// own `Intl` data (no date library). Instants are epoch milliseconds; a local date is a
// proleptic Gregorian calendar date. A wall-clock time repeated by a fall-back change means its
// earlier instant (as in Temporal's "compatible" mode); one skipped by a spring-forward change
// means the moment of the change (02:30 → 03:00 EDT), not Temporal's "one gap later" (03:30),
// so that later local times never map to earlier instants: working intervals that do not
// overlap on the clock never overlap in real time either. Shared here (S14) so the
// appointments engine and the web app's calendar use the same conversion.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** A calendar date. */
export interface CivilDate {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

/** What a business's clock and calendar show at an instant. */
export interface ZonedDateTime extends CivilDate {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Minutes after local midnight, 0–1439. */
  minuteOfDay: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

/** The wall-clock fields at `instant`, seconds included (offsets are whole minutes here). */
function wallClock(timeZone: string, instant: number) {
  const fields = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type in fields) fields[part.type as keyof typeof fields] = Number(part.value);
  }
  return fields;
}

/** The time zone's offset from UTC at `instant`, in minutes (New York in winter: -300). */
export function offsetMinutes(timeZone: string, instant: number): number {
  const wall = wallClock(timeZone, instant);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const wholeSeconds = Math.floor(instant / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSeconds) / MINUTE_MS);
}

/** What the business's clock and calendar show at `instant`. */
export function toZoned(timeZone: string, instant: number): ZonedDateTime {
  const wall = wallClock(timeZone, instant);
  const date = { year: wall.year, month: wall.month, day: wall.day };
  return { ...date, weekday: isoWeekday(date), minuteOfDay: wall.hour * 60 + wall.minute };
}

/**
 * The instant at which the business's clock shows `minuteOfDay` on `date`. `minuteOfDay` may
 * be 1440 or more (it then falls on a later day: 24:00 is the next midnight).
 */
export function fromZoned(timeZone: string, date: CivilDate, minuteOfDay: number): number {
  const localAsUtc = Date.UTC(date.year, date.month - 1, date.day, 0, minuteOfDay);
  // Real zones change their offset at most once within a day either side, so the offsets a
  // day before and a day after are the only candidates.
  const before = offsetMinutes(timeZone, localAsUtc - DAY_MS);
  const after = offsetMinutes(timeZone, localAsUtc + DAY_MS);
  const earlier = localAsUtc - Math.max(before, after) * MINUTE_MS;
  const later = localAsUtc - Math.min(before, after) * MINUTE_MS;
  const shows = (instant: number) =>
    instant + offsetMinutes(timeZone, instant) * MINUTE_MS === localAsUtc;
  if (shows(earlier)) return earlier;
  if (shows(later)) return later;
  // Skipped by a spring-forward change (the offset grows from `before` to `after`): the moment
  // of the change, the first minute in (earlier, later] already on the new offset.
  let low = earlier;
  let high = later;
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
    if (offsetMinutes(timeZone, middle) === after) high = middle;
    else low = middle;
  }
  return high;
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: CivilDate): number {
  const sundayZero = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return sundayZero === 0 ? 7 : sundayZero;
}

/** The calendar date `days` after `date`. */
export function addDays(date: CivilDate, days: number): CivilDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

/** `YYYY-MM-DD` of a calendar date (years 1000–9999). */
export function formatDate(date: CivilDate): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.year)}-${pad(date.month)}-${pad(date.day)}`;
}

/** The calendar date of `YYYY-MM-DD`. */
export function parseDate(text: string): CivilDate {
  const [year, month, day] = text.split('-').map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}
