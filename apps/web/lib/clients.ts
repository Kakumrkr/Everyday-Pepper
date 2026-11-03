import {
  ClientBirthdaySchema,
  ClientTagsSchema,
  type ClientBirthday,
  type ClientRecords,
} from '@pepper/contracts';

// A client's details in words (S49.2, AC-W1-28), and as the profile's editor reads them (S50).

export const MONTHS = [
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

/** Tags as the editor shows them: comma-separated. */
export function tagsText(tags: readonly string[]): string {
  return tags.join(', ');
}

/**
 * Tags as typed (AC-W1-32): split on commas, tidied, repeats dropped ignoring case; `null`
 * when there are too many or one is too long.
 */
export function tagsFromText(text: string): string[] | null {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const parsed = ClientTagsSchema.safeParse(parts);
  return parsed.success ? parsed.data : null;
}

/**
 * A birthday from the editor's month, day and optional year: `null` when month and day are
 * both empty (no birthday), `'invalid'` when it isn't a real date.
 */
export function birthdayFromForm(
  month: string,
  day: string,
  year: string,
): ClientBirthday | null | 'invalid' {
  if (month === '' && day.trim() === '' && year.trim() === '') return null;
  const number = (text: string) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN);
  const parsed = ClientBirthdaySchema.safeParse({
    month: number(month),
    day: number(day),
    year: year.trim() === '' ? null : number(year),
  });
  return parsed.success ? parsed.data : 'invalid';
}

function count(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** What a merge moves, in one sentence (AC-W1-30). */
export function mergeSentence(other: string, kept: string, records: ClientRecords): string {
  const visits = records.upcomingVisits + records.pastVisits;
  const parts = [
    ...(visits === 0 ? [] : [count(visits, 'visit', 'visits')]),
    ...(records.waitlistEntries === 0
      ? []
      : [count(records.waitlistEntries, 'waitlist entry', 'waitlist entries')]),
    ...(records.notes === 0 ? [] : [count(records.notes, 'note', 'notes')]),
  ];
  const moves =
    parts.length === 0
      ? `${other} has no visits or notes to move.`
      : `${other}’s ${listOf(parts)} move to ${kept}.`;
  return `${moves} Their email, phone, birthday and tags fill what ${kept} is missing, then ${other} is removed. This can’t be undone.`;
}

/** What a deletion keeps and forgets, in sentences (AC-W1-31); `null` while it can't happen. */
export function deleteSentence(name: string, records: ClientRecords): string | null {
  if (records.upcomingVisits > 0) return null;
  const kept =
    records.pastVisits === 0
      ? ''
      : `${count(records.pastVisits, 'past visit stays', 'past visits stay')} in your history as “Deleted client”. `;
  const notes =
    records.notes === 0 ? '' : ` and ${count(records.notes, 'note', 'notes')} about them`;
  return `${kept}I’ll forget ${name}’s name, email, phone, tags and birthday${notes}, everywhere I keep them. This can’t be undone.`;
}

/** Why a client can't be deleted yet (AC-W1-31). */
export function upcomingSentence(name: string, records: ClientRecords): string {
  return `${name} has ${count(records.upcomingVisits, 'visit', 'visits')} coming up. Cancel or move ${records.upcomingVisits === 1 ? 'it' : 'them'} first, then delete.`;
}

function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}
