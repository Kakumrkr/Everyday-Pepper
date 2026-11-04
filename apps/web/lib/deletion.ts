// Deleting the business or the account (S51.2, ADR-0054, AC-W1-40, AC-W1-42): the api's
// paths, and the day in words. The api counts the 30 days and decides who may ask.

export const BUSINESS_DELETION_PATH = '/v1/tenant/deletion';
export const ACCOUNT_DELETION_PATH = '/v1/me/deletion';

/** The day a deletion happens, in the business's time zone: "Friday, December 4". */
export function deletionDayLabel(dueAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(new Date(dueAt));
}
