import type { Weekday, WorkingInterval } from '@pepper/contracts';

/** The same opening hours on each of `weekdays` (1 = Monday … 7 = Sunday), for `defaultHours`. */
export function days(weekdays: readonly Weekday[], start: string, end: string): WorkingInterval[] {
  return weekdays.map((weekday) => ({ weekday, start, end }));
}
