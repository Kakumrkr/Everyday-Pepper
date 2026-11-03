import type { ClientBirthday } from '@pepper/contracts';

// A client's details in words (S49.2, AC-W1-28).

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * A birthday as the profile says it: "March 12", or "March 12, 1990" when the year is known.
 * A calendar date, not an instant: no time zone moves it a day.
 */
export function birthdayLabel(birthday: ClientBirthday): string {
  const day = `${MONTHS[birthday.month - 1] ?? ''} ${String(birthday.day)}`;
  return birthday.year === null ? day : `${day}, ${String(birthday.year)}`;
}
