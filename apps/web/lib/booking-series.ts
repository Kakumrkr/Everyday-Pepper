import {
  visitNumber,
  type BookingSeries,
  type BookingSeriesPreview,
  type BookingSeriesResult,
} from '@pepper/contracts';
import { dateTimeLabel } from './booking';

// Recurring appointments on screen (S72, ADR-0070): the new-booking sheet's "Repeat", the dates
// it checked, what was booked, and the booking sheet's "Visit 3 of 8". Pure, so the words and
// the choice of dates are tested here.

/** "Doesn't repeat" or every 1–4 weeks, as the Repeat select offers them. */
export const REPEAT_OPTIONS = [
  { value: '0', label: 'Doesn’t repeat' },
  { value: '1', label: 'Every week' },
  { value: '2', label: 'Every 2 weeks' },
  { value: '3', label: 'Every 3 weeks' },
  { value: '4', label: 'Every 4 weeks' },
] as const;

/** 2–26 visits, the first one included. */
export const VISIT_COUNT_OPTIONS = Array.from({ length: 25 }, (_, index) => ({
  value: String(index + 2),
  label: `${String(index + 2)} visits`,
}));

/** What a repeat starts at: two months weekly (the commonest regular). */
export const DEFAULT_VISITS = 8;

/** "every week", "every 2 weeks". */
export function everyLabel(everyWeeks: number): string {
  return everyWeeks === 1 ? 'every week' : `every ${String(everyWeeks)} weeks`;
}

/**
 * The start times to book from a preview: every free date, and for a date that isn't free the
 * alternative picked for it (`picks`, by the date's place); dates with neither are left out.
 * Earliest first.
 */
export function visitsToBook(
  preview: BookingSeriesPreview,
  picks: Readonly<Record<number, string>>,
): string[] {
  const starts: string[] = [];
  preview.visits.forEach((visit, index) => {
    const picked = picks[index];
    if (visit.free) starts.push(visit.startsAt);
    else if (picked !== undefined) starts.push(picked);
  });
  return starts.sort((a, b) => Date.parse(a) - Date.parse(b));
}

/** The picks with `at` chosen for the date at `index` (`null`: that date left out again). */
export function withPick(
  picks: Readonly<Record<number, string>>,
  index: number,
  at: string | null,
): Record<number, string> {
  const next: Record<number, string> = {};
  for (const [place, picked] of Object.entries(picks)) {
    if (Number(place) !== index) next[Number(place)] = picked;
  }
  if (at !== null) next[index] = at;
  return next;
}

/** Why a date isn't free, in the sheet's words. */
export function notFreeLine(
  visit: BookingSeriesPreview['visits'][number],
  maximumAdvanceDays: number,
): string {
  if (visit.tooFarAhead) {
    return `Not free: further ahead than you take bookings (${String(maximumAdvanceDays)} days)`;
  }
  return visit.alternatives.length === 0
    ? 'Not free, and nothing free nearby'
    : 'Not free. Tap a time nearby instead:';
}

/** The main button's words for the dates chosen. */
export function bookLabel(count: number): string {
  return count === 1 ? 'Book 1 visit' : `Book ${String(count)} visits`;
}

/**
 * What was booked, said once the series is in: "7 visits booked, every week." and, when some
 * date was taken meanwhile, which ones weren't.
 */
export function bookedLines(result: BookingSeriesResult, timeZone: string): string[] {
  const booked = result.bookings.length;
  const lines = [
    `${String(booked)} ${booked === 1 ? 'visit' : 'visits'} booked, ${everyLabel(result.everyWeeks)}.`,
  ];
  if (result.skipped.length > 0) {
    const dates = result.skipped.map((visit) => dateTimeLabel(timeZone, visit.startsAt));
    lines.push(`Not booked, taken just now: ${dates.join(', ')}.`);
  }
  return lines;
}

/** "Visit 3 of 8 · every week" for the booking sheet; `null` when it isn't counted. */
export function seriesLine(series: BookingSeries, bookingId: string): string | null {
  const place = visitNumber(series.bookings, bookingId);
  if (place === null) return null;
  return `Visit ${String(place.number)} of ${String(place.of)} · ${everyLabel(series.everyWeeks)}`;
}

/** The confirmed visits of the series after this one, which "This and following" also cancels. */
export function laterVisits(series: BookingSeries, booking: { id: string; startsAt: string }) {
  return series.bookings.filter(
    (visit) =>
      visit.id !== booking.id &&
      visit.status === 'confirmed' &&
      Date.parse(visit.startsAt) >= Date.parse(booking.startsAt),
  );
}
