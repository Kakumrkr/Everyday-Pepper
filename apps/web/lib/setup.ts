import {
  addDays,
  formatDate,
  fromZoned,
  minutesOfDay,
  parseDate,
  toZoned,
  type Booking,
  type Rule,
  type RuleDefaults,
  type RuleInput,
  type Service,
  type SlotIntervalMinutes,
  type WeeklyHours,
  type WeeklyHoursInput,
} from '@pepper/contracts';

// The setup screens (S16): services, staff hours and time off, booking rules and a client's
// visits. Everything here is pure; the screens call the api, which validates and decides.

// Money ------------------------------------------------------------------------------------

/**
 * Cents from a price as typed (`65`, `$65.50`, `1,200`): `null` for an empty field, `'invalid'`
 * for anything else that is not an amount with at most two decimals.
 */
export function centsFromText(text: string): number | null | 'invalid' {
  if (text.trim() === '') return null;
  const cleaned = text.trim().replace(/^\$/, '').replace(/,/g, '').trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return 'invalid';
  const [, dollars = '0', cents = ''] = match;
  return Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
}

/** A price field's text for `cents`: `65`, `65.50`, or empty for none. */
export function textFromCents(cents: number | null): string {
  if (cents === null) return '';
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(dollars) : `${String(dollars)}.${String(rest).padStart(2, '0')}`;
}

/** `$65` or `$65.50`. */
export function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** A service's price as clients see it: `from $65`, `$65–$80`, or `null` for none. */
export function priceLabel(
  service: Pick<Service, 'priceFromCents' | 'priceToCents'>,
): string | null {
  const { priceFromCents: from, priceToCents: to } = service;
  if (from === null) return null;
  return to === null ? `from ${money(from)}` : `${money(from)}–${money(to)}`;
}

/** `45 min`, `1 h`, `1 h 30 min`. */
export function durationLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** Services grouped by category (by name, case-insensitive); those without one last. */
export function servicesByCategory<T extends Pick<Service, 'category'>>(
  services: readonly T[],
): { category: string | null; services: T[] }[] {
  const groups = new Map<string, { category: string | null; services: T[] }>();
  for (const service of services) {
    const key = service.category?.toLowerCase() ?? '';
    const group = groups.get(key) ?? { category: service.category, services: [] };
    group.services.push(service);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([, group]) => group);
}

// Weekly hours -----------------------------------------------------------------------------

/** ISO weekdays, Monday first, with their names. */
export const WEEKDAYS = [
  { weekday: 1, short: 'Mon', long: 'Monday' },
  { weekday: 2, short: 'Tue', long: 'Tuesday' },
  { weekday: 3, short: 'Wed', long: 'Wednesday' },
  { weekday: 4, short: 'Thu', long: 'Thursday' },
  { weekday: 5, short: 'Fri', long: 'Friday' },
  { weekday: 6, short: 'Sat', long: 'Saturday' },
  { weekday: 7, short: 'Sun', long: 'Sunday' },
] as const;

export interface DayInterval {
  start: string;
  end: string;
}

/** One weekday of the hours editor: no intervals is a day off. */
export interface DayHours {
  weekday: number;
  intervals: DayInterval[];
}

/** The seven days of a staff member's week, Monday first. */
export function weekOf(hours: WeeklyHours): DayHours[] {
  return WEEKDAYS.map(({ weekday }) => ({
    weekday,
    intervals: hours.intervals
      .filter((interval) => interval.weekday === weekday)
      .map(({ start, end }) => ({ start, end })),
  }));
}

/** The body of `PUT /v1/staff/:id/hours` for the editor's week. */
export function hoursFromWeek(week: readonly DayHours[]): WeeklyHoursInput {
  return {
    intervals: week.flatMap((day) =>
      day.intervals.map((interval) => ({ weekday: day.weekday, ...interval })),
    ),
  };
}

/** The hours a new working day starts with. */
export const DEFAULT_DAY: DayInterval = { start: '09:00', end: '17:00' };

/**
 * Times to pick from, every 15 minutes from `00:00` to `24:00` (midnight at the end of the
 * day), plus any `extra` stored times off that grid, in order.
 */
export function timeChoices(extra: readonly string[] = []): string[] {
  const grid = Array.from({ length: 97 }, (_, index) => {
    const minutes = index * 15;
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  });
  return [...new Set([...grid, ...extra])].sort((a, b) => minutesOfDay(a) - minutesOfDay(b));
}

/** `9:00 AM`, `12:30 PM`; `24:00` is `midnight`. */
export function clockLabel(time: string): string {
  const minutes = minutesOfDay(time);
  if (minutes === 1440) return 'midnight';
  const hours = Math.floor(minutes / 60);
  const suffix = hours < 12 ? 'AM' : 'PM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(hour12)}:${String(minutes % 60).padStart(2, '0')} ${suffix}`;
}

/**
 * The week in a few lines: consecutive days with the same hours together, e.g.
 * `Mon–Fri 9:00 AM–5:00 PM`; days off are left out. An empty list: no hours at all.
 */
export function hoursSummary(hours: WeeklyHours): string[] {
  const week = weekOf(hours);
  const lines: string[] = [];
  let index = 0;
  while (index < week.length) {
    const day = week[index];
    let last = index;
    const key = intervalsKey(day?.intervals ?? []);
    while (last + 1 < week.length && intervalsKey(week[last + 1]?.intervals ?? []) === key) {
      last += 1;
    }
    if (day !== undefined && day.intervals.length > 0) {
      const first = WEEKDAYS[index]?.short ?? '';
      const days = last === index ? first : `${first}–${WEEKDAYS[last]?.short ?? ''}`;
      const times = day.intervals
        .map((interval) => `${clockLabel(interval.start)}–${clockLabel(interval.end)}`)
        .join(', ');
      lines.push(`${days} ${times}`);
    }
    index = last + 1;
  }
  return lines;
}

function intervalsKey(intervals: readonly DayInterval[]): string {
  return intervals.map((interval) => `${interval.start}-${interval.end}`).join(',');
}

// Time off ---------------------------------------------------------------------------------

/**
 * Time off as entered on the business's clock: whole days from `firstDay` to `lastDay` (both
 * included), or, with `from` and `to`, part of one day.
 */
export interface TimeOffEntry {
  firstDay: string;
  lastDay: string;
  from?: string | undefined;
  to?: string | undefined;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;

/**
 * The exact span (UTC) of time off entered on the business's clock, or `null` when the dates
 * or times are missing, malformed or backwards. The api checks the length.
 */
export function timeOffSpan(
  timeZone: string,
  entry: TimeOffEntry,
): { startsAt: string; endsAt: string } | null {
  if (!DATE_PATTERN.test(entry.firstDay)) return null;
  const first = parseDate(entry.firstDay);
  const at = (date: string, minute: number) =>
    new Date(fromZoned(timeZone, parseDate(date), minute)).toISOString();
  if (entry.from !== undefined || entry.to !== undefined) {
    const { from = '', to = '' } = entry;
    if (!TIME_PATTERN.test(from) || !TIME_PATTERN.test(to)) return null;
    if (minutesOfDay(to) <= minutesOfDay(from)) return null;
    return {
      startsAt: at(entry.firstDay, minutesOfDay(from)),
      endsAt: at(entry.firstDay, minutesOfDay(to)),
    };
  }
  if (!DATE_PATTERN.test(entry.lastDay)) return null;
  const last = parseDate(entry.lastDay);
  if (formatDate(last) < formatDate(first)) return null;
  return {
    startsAt: at(entry.firstDay, 0),
    endsAt: new Date(fromZoned(timeZone, addDays(last, 1), 0)).toISOString(),
  };
}

/**
 * Time off in words on the business's clock: `Tue, Nov 3`, `Tue, Nov 3 – Thu, Nov 5` for whole
 * days, else `Tue, Nov 3, 9:00 AM – 1:00 PM` (or both ends with their dates).
 */
export function timeOffLabel(timeZone: string, span: { startsAt: string; endsAt: string }): string {
  const start = toZoned(timeZone, Date.parse(span.startsAt));
  const end = toZoned(timeZone, Date.parse(span.endsAt));
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(`${iso}T12:00:00Z`));
  const time = (minute: number) =>
    clockLabel(
      `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
    );
  if (start.minuteOfDay === 0 && end.minuteOfDay === 0) {
    const lastDay = formatDate(addDays(end, -1));
    const firstDay = formatDate(start);
    return lastDay === firstDay ? day(firstDay) : `${day(firstDay)} – ${day(lastDay)}`;
  }
  const startText = `${day(formatDate(start))}, ${time(start.minuteOfDay)}`;
  return formatDate(start) === formatDate(end)
    ? `${startText} – ${time(end.minuteOfDay)}`
    : `${startText} – ${day(formatDate(end))}, ${time(end.minuteOfDay)}`;
}

// Booking rules ----------------------------------------------------------------------------

/** The business-wide rules the rules screen edits; `null`: the default applies. */
export interface BusinessRules {
  slotIntervalMinutes: SlotIntervalMinutes | null;
  minimumNoticeMinutes: number | null;
  maximumAdvanceDays: number | null;
  maxBookingsPerDay: number | null;
  /** Closed days, local dates, both ends included. */
  blackouts: { startDate: string; endDate: string }[];
}

/** The business-wide rules of a rule set (staff members' own rules are left out). */
export function businessRulesOf(rules: readonly Rule[]): BusinessRules {
  const business = rules.filter((rule) => rule.staffMemberId === null);
  const find = <T extends Rule['type']>(type: T) =>
    business.find((rule): rule is Extract<Rule, { type: T }> => rule.type === type);
  return {
    slotIntervalMinutes: find('slot_interval')?.params.minutes ?? null,
    minimumNoticeMinutes: find('minimum_notice')?.params.minutes ?? null,
    maximumAdvanceDays: find('maximum_advance')?.params.days ?? null,
    maxBookingsPerDay: find('max_bookings_per_day')?.params.count ?? null,
    blackouts: business
      .filter(
        (rule): rule is Extract<Rule, { type: 'blackout_window' }> =>
          rule.type === 'blackout_window',
      )
      .map((rule) => ({ startDate: rule.params.startDate, endDate: rule.params.endDate })),
  };
}

/**
 * The whole rule set for `PUT /v1/rules`: the edited business-wide rules, and every staff
 * member's own rule as it was (the screen does not edit those).
 */
export function withBusinessRules(rules: readonly Rule[], business: BusinessRules): RuleInput[] {
  const own: RuleInput[] = rules.filter((rule) => rule.staffMemberId !== null);
  const set: RuleInput[] = [];
  if (business.slotIntervalMinutes !== null) {
    set.push({ type: 'slot_interval', params: { minutes: business.slotIntervalMinutes } });
  }
  if (business.minimumNoticeMinutes !== null) {
    set.push({ type: 'minimum_notice', params: { minutes: business.minimumNoticeMinutes } });
  }
  if (business.maximumAdvanceDays !== null) {
    set.push({ type: 'maximum_advance', params: { days: business.maximumAdvanceDays } });
  }
  if (business.maxBookingsPerDay !== null) {
    set.push({ type: 'max_bookings_per_day', params: { count: business.maxBookingsPerDay } });
  }
  for (const blackout of business.blackouts) {
    set.push({ type: 'blackout_window', params: blackout });
  }
  return [...set, ...own];
}

/** Notice choices on the rules screen, in minutes (a stored value outside them is kept). */
export const NOTICE_CHOICES = [0, 30, 60, 120, 240, 720, 1440, 2880, 10080] as const;
/** How far ahead choices, in days. */
export const ADVANCE_CHOICES = [7, 14, 30, 60, 90, 180, 365] as const;

/** `no notice`, `30 minutes`, `2 hours`, `1 day`, `1 week`. */
export function noticeLabel(minutes: number): string {
  if (minutes === 0) return 'no notice';
  const plural = (n: number, unit: string) => `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
  if (minutes % 10080 === 0) return plural(minutes / 10080, 'week');
  if (minutes % 1440 === 0) return plural(minutes / 1440, 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

/** The choices, with the stored value added in order when it is not one of them. */
export function choicesWith(choices: readonly number[], current: number | null): number[] {
  if (current === null || choices.includes(current)) return [...choices];
  return [...choices, current].sort((a, b) => a - b);
}

/** Closed days in words: `Fri, Dec 25, 2026` or `Thu, Dec 24, 2026 – Sat, Dec 26, 2026`. */
export function closedDaysLabel(blackout: { startDate: string; endDate: string }): string {
  const day = (iso: string) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${iso}T12:00:00Z`));
  return blackout.startDate === blackout.endDate
    ? day(blackout.startDate)
    : `${day(blackout.startDate)} – ${day(blackout.endDate)}`;
}

/** `90 days`, `1 day`. */
export function daysLabel(days: number): string {
  return `${String(days)} day${days === 1 ? '' : 's'}`;
}

/** A sentence for the defaults in force, e.g. for the rules screen's hints. */
export function defaultsLabel(defaults: RuleDefaults): string {
  return [
    `every ${String(defaults.slotIntervalMinutes)} minutes`,
    `${noticeLabel(defaults.minimumNoticeMinutes)} ahead`,
    `up to ${daysLabel(defaults.maximumAdvanceDays)} out`,
    defaults.maxBookingsPerDay === null
      ? 'no daily limit'
      : `at most ${String(defaults.maxBookingsPerDay)} a day`,
  ].join(', ');
}

// A client's visits ------------------------------------------------------------------------

/** How far back and ahead a client profile looks (the api's longest range, 62 days). */
export const VISIT_WINDOW_DAYS = 62;

/** The two `GET /v1/bookings` ranges of a client profile: before and after `now`. */
export function visitRanges(now: number): {
  past: { from: string; to: string };
  upcoming: { from: string; to: string };
} {
  const day = 86_400_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    past: { from: iso(now - VISIT_WINDOW_DAYS * day), to: iso(now) },
    upcoming: { from: iso(now), to: iso(now + VISIT_WINDOW_DAYS * day) },
  };
}

/**
 * A client's bookings, split at `now`: upcoming ones (not cancelled), soonest first, and past
 * ones, latest first. A booking in both answers (it spans `now`) counts once, as upcoming.
 */
export function splitVisits(
  bookings: readonly Booking[],
  now: number,
): { upcoming: Booking[]; past: Booking[] } {
  const unique = [...new Map(bookings.map((booking) => [booking.id, booking])).values()];
  const upcoming = unique
    .filter((b) => Date.parse(b.endsAt) > now && b.status !== 'cancelled')
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const past = unique
    .filter((b) => Date.parse(b.endsAt) <= now)
    .sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt));
  return { upcoming, past };
}

// Staff ------------------------------------------------------------------------------------

/** Colours offered for a staff member on the calendar (a stored other colour is kept). */
export const STAFF_COLORS = [
  { value: '#2a7230', name: 'Green' },
  { value: '#0b6b63', name: 'Teal' },
  { value: '#1d65a8', name: 'Blue' },
  { value: '#7a3b8f', name: 'Plum' },
  { value: '#b4483a', name: 'Coral' },
  { value: '#8f4c00', name: 'Amber' },
  { value: '#536257', name: 'Slate' },
] as const;

/** The local date `days` after today on the business's clock (`YYYY-MM-DD`). */
export function localDateIn(timeZone: string, now: number, days = 0): string {
  return formatDate(addDays(toZoned(timeZone, now), days));
}
