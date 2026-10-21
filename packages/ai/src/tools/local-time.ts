import {
  addDays,
  clockTime,
  formatDate,
  fromZoned,
  parseDate,
  toZoned,
  type LocalDate,
  type LocalTime,
} from '@pepper/contracts';

// The tools speak the business's wall clock (playbook principle 5): the model reads dates off
// the prompt's date table and passes `YYYY-MM-DD` and `HH:MM` in the business's time zone; the
// tools convert to UTC instants with the shared helpers (a time skipped by a spring-forward
// change means the moment of the change; a repeated one its first instant), and answer in the
// same local terms.

/** The UTC instant (ISO) of a local date and time in `timeZone`. */
export function instantOf(timeZone: string, date: LocalDate, time: LocalTime): string {
  return new Date(fromZoned(timeZone, parseDate(date), minutesOf(time))).toISOString();
}

/** The local date and time of an instant in `timeZone`. */
export function localOf(timeZone: string, instant: Date | string): { date: string; time: string } {
  const zoned = toZoned(timeZone, new Date(instant).getTime());
  return { date: formatDate(zoned), time: clockTime(zoned.minuteOfDay) };
}

/** [from, to) covering `days` whole local days from `date` in `timeZone`, as ISO instants. */
export function daysOf(timeZone: string, date: LocalDate, days = 1): { from: string; to: string } {
  const start = parseDate(date);
  return {
    from: new Date(fromZoned(timeZone, start, 0)).toISOString(),
    to: new Date(fromZoned(timeZone, addDays(start, days), 0)).toISOString(),
  };
}

function minutesOf(time: LocalTime): number {
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return hours * 60 + minutes;
}
