import {
  ClientTagSchema,
  daysInMonth,
  MAX_CLIENT_TAG_LENGTH,
  MAX_CLIENT_TAGS,
  type CivilDate,
  type ClientBirthday,
} from '@pepper/contracts';

// How a file's cells read as dates, times, lengths, prices, statuses, birthdays and tags
// (S49, ADR-0050). Exports from US tools write dates as 1/5/2026, ISO (2026-01-05, with or
// without a time and an offset) or with a month name (Jan 5, 2026); times as 2:30 PM or 14:30.
// Pure: `null` is "can't be read", and the caller words the reason.

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** A date as a file writes it, with its time when it has one. */
export interface CellDate {
  date: CivilDate;
  /** Minutes after midnight, when the cell has a time. */
  minute: number | null;
  /** The cell's own UTC offset in minutes (an ISO time with `Z` or `+02:00`). */
  offset: number | null;
}

function monthOf(word: string): number | null {
  const at = MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
  return at === -1 ? null : at + 1;
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length > 2) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function validDate(year: number, month: number, day: number): CivilDate | null {
  if (!Number.isInteger(year) || year < 1900 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return null;
  return { year, month, day };
}

/** `2:30 PM`, `2:30pm`, `2 pm`, `14:30`, `14:30:00`; minutes after midnight. */
export function readTime(cell: string): number | null {
  const match = /^(\d{1,2})(?:[:.](\d{2}))?(?::(\d{2})(?:\.\d+)?)?\s*([ap])?\.?\s*m?\.?$/i.exec(
    cell.trim(),
  );
  if (match === null) return null;
  const [, h = '', m, , meridiem] = match;
  let hour = Number(h);
  const minute = m === undefined ? 0 : Number(m);
  if (minute > 59) return null;
  if (meridiem === undefined) {
    // A bare "14" isn't a time; "14:30" is.
    if (m === undefined || hour > 23) return null;
  } else {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
  }
  return hour * 60 + minute;
}

/** Splits "2026-01-05 2:30 PM" or "Jan 5, 2026 at 2:30 PM" into the date and the time. */
function withTime(cell: string, readDate: (text: string) => CivilDate | null): CellDate | null {
  const text = cell.trim();
  const whole = readDate(text);
  if (whole !== null) return { date: whole, minute: null, offset: null };
  // The time is the last one or two words (2:30 PM, 14:30, 2pm), after a space, comma or "at".
  const match =
    /^(.*?)(?:,?\s+(?:at\s+)?|T)(\d{1,2}(?:[:.]\d{2}){0,2}(?:\.\d+)?\s*(?:[ap]\.?m?\.?)?)$/i.exec(
      text,
    );
  if (match === null) return null;
  const [, datePart = '', timePart = ''] = match;
  const date = readDate(datePart.trim());
  const minute = readTime(timePart);
  if (date === null || minute === null) return null;
  return { date, minute, offset: null };
}

/** `2026-01-05`, `2026-01-05T14:30:00`, `2026-01-05T14:30:00Z`, `2026-01-05 14:30-05:00`. */
function readIso(cell: string): CellDate | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i.exec(
      cell.trim(),
    );
  if (match === null) return null;
  const [, y = '', mo = '', d = '', h, mi, , zone] = match;
  const date = validDate(Number(y), Number(mo), Number(d));
  if (date === null) return null;
  if (h === undefined || mi === undefined) return { date, minute: null, offset: null };
  const hour = Number(h);
  const minuteOfHour = Number(mi);
  if (hour > 23 || minuteOfHour > 59) return null;
  let offset: number | null = null;
  if (zone !== undefined) {
    if (zone.toUpperCase() === 'Z') offset = 0;
    else {
      const digits = zone.slice(1).replace(':', '');
      const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0');
      offset = zone.startsWith('-') ? -minutes : minutes;
    }
  }
  return { date, minute: hour * 60 + minuteOfHour, offset };
}

/** `1/5/2026`, `01/05/26`, `1-5-2026` (month first, as US tools write it). */
function readUsDate(text: string): CivilDate | null {
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(text);
  if (match === null) return null;
  const [, m = '', d = '', y = ''] = match;
  return validDate(fullYear(y), Number(m), Number(d));
}

/** `Jan 5, 2026`, `January 5 2026`, `5 Jan 2026`, `Mon, Jan 5, 2026`. */
function readNamedDate(text: string): CivilDate | null {
  const words = text
    .replace(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i, '')
    .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
    .replace(/[,.]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length !== 3) return null;
  const [a = '', b = '', c = ''] = words;
  if (!/^\d{2,4}$/.test(c)) return null;
  const year = fullYear(c);
  if (/^\d{1,2}$/.test(a)) {
    const month = monthOf(b);
    return month === null ? null : validDate(year, month, Number(a));
  }
  const month = monthOf(a);
  return month === null || !/^\d{1,2}$/.test(b) ? null : validDate(year, month, Number(b));
}

function readPlainDate(text: string): CivilDate | null {
  return readUsDate(text) ?? readNamedDate(text) ?? readIso(text)?.date ?? null;
}

/** A visit's date (and time, when the cell has one); `null` when it can't be read. */
export function readDate(cell: string): CellDate | null {
  const text = cell.trim();
  if (text === '') return null;
  return readIso(text) ?? withTime(text, readPlainDate);
}

/** `45`, `45 min`, `1h 30m`, `1 hr 30 mins`, `1:30`, `1.5 hours`; whole minutes. */
export function readDuration(cell: string): number | null {
  const text = cell.trim().toLowerCase();
  let minutes: number | null = null;
  const plain = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)?$/.exec(text);
  const hours = /^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/.exec(text);
  const both = /^(\d+)\s*(?:h|hr|hrs|hour|hours)\s*(\d+)\s*(?:m|min|mins|minute|minutes)?$/.exec(
    text,
  );
  const clock = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (plain !== null) minutes = Number(plain[1]);
  else if (hours !== null) minutes = Number(hours[1]) * 60;
  else if (both !== null) minutes = Number(both[1]) * 60 + Number(both[2]);
  else if (clock !== null) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  if (minutes === null || !Number.isFinite(minutes)) return null;
  return Math.round(minutes);
}

/** The most a price may be: $100,000.00. */
const MAX_PRICE_CENTS = 10_000_000;

/** `$45`, `45.50`, `1,200`, `USD 45`; cents. */
export function readPrice(cell: string): number | null {
  const text = cell
    .trim()
    .replace(/^usd\s*/i, '')
    .replace(/\s*usd$/i, '')
    .replace(/^\$\s*/, '')
    .replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  return cents > MAX_PRICE_CENTS ? null : cents;
}

/** What a visit's status says: it happened (or will), the client didn't come, or cancelled. */
export type CellStatus = 'kept' | 'no_show' | 'cancelled';

/** A status cell; unknown words are read as "kept" (the date decides past or upcoming). */
export function readStatus(cell: string): CellStatus {
  const text = cell
    .trim()
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (/^(noshow|noshowed|missed|didnotshow|didntshow|absent)/.test(text)) return 'no_show';
  if (/^(cancel|canceled|cancelled|latecancel|deleted|void|declined|rejected)/.test(text)) {
    return 'cancelled';
  }
  return 'kept';
}

/**
 * A birthday: `1990-04-12`, `4/12/1990`, `4/12`, `--04-12`, `April 12`, `12 Apr`, `Apr 12, 1990`.
 * A year of 1900 or before is a tool's placeholder for "no year".
 */
export function readBirthday(cell: string): ClientBirthday | null {
  const text = cell.trim().replace(/[,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  const noYear = /^--(\d{2})-(\d{2})$/.exec(text);
  const us = /^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?$/.exec(text);
  if (iso !== null) [month, day, year] = [Number(iso[2]), Number(iso[3]), Number(iso[1])];
  else if (noYear !== null) [month, day] = [Number(noYear[1]), Number(noYear[2])];
  else if (us !== null) {
    [month, day] = [Number(us[1]), Number(us[2])];
    year = us[3] === undefined ? null : fullYear(us[3]);
  } else {
    const words = text.replace(/(\d)(st|nd|rd|th)\b/gi, '$1').split(' ');
    const [a = '', b = '', c] = words;
    if (words.length > 3) return null;
    if (/^\d{1,2}$/.test(a)) [day, month] = [Number(a), monthOf(b)];
    else if (/^\d{1,2}$/.test(b)) [month, day] = [monthOf(a), Number(b)];
    if (c !== undefined) year = /^\d{4}$/.test(c) ? Number(c) : Number.NaN;
  }
  if (month === null || day === null || Number.isNaN(year)) return null;
  if (year !== null && year <= 1900) year = null;
  if (year !== null && year > new Date().getUTCFullYear()) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(month, year)) return null;
  return { month, day, year };
}

/** A cell's tags: split on commas, semicolons and bars, tidied, without repeats. */
export function readTags(cells: readonly string[]): { tags: string[]; cut: boolean } {
  const seen = new Set<string>();
  const tags: string[] = [];
  let cut = false;
  for (const part of cells.flatMap((cell) => cell.split(/[,;|]/))) {
    const parsed = ClientTagSchema.safeParse(part);
    if (!parsed.success) {
      if (part.trim().length > MAX_CLIENT_TAG_LENGTH) cut = true;
      continue;
    }
    const key = parsed.data.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (tags.length === MAX_CLIENT_TAGS) {
      cut = true;
      continue;
    }
    tags.push(parsed.data);
  }
  return { tags, cut };
}
