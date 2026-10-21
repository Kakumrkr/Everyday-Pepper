import { addDays, formatDate, isoWeekday, toZoned } from '@pepper/contracts';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * The business clock for a prompt (playbook §3.5): "now" in the business's time zone and the
 * next `days` dates with their weekdays, so the model reads "Friday" or "tomorrow" off a table
 * instead of doing date math. Tools take these local dates; the domain converts them.
 */
export function businessClock(now: Date, timeZone: string, days = 14): string {
  const zoned = toZoned(timeZone, now.getTime());
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(now);
  const dates = Array.from({ length: days }, (_unused, offset) => {
    const date = addDays(zoned, offset);
    const label = offset === 0 ? ' (today)' : offset === 1 ? ' (tomorrow)' : '';
    return `${WEEKDAYS[isoWeekday(date) - 1] ?? ''} ${formatDate(date)}${label}`;
  });
  return [
    `Now: ${time} (${timeZone}).`,
    `Dates in the business time zone: ${dates.join('; ')}.`,
  ].join('\n');
}
