// How a client's email names the day of a visit: "November 4", in the business's time zone,
// and "November 4, 2024" when that day was over a year ago (an old visit without its year reads
// as this year's).

const YEAR_MS = 365 * 86_400_000;

/** The visit's day for a client's email: with its year once it is more than a year back. */
export function visitDateWords(timeZone: string, visitAt: Date | string, now: Date): string {
  const at = new Date(visitAt);
  return at.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    ...(now.getTime() - at.getTime() > YEAR_MS && { year: 'numeric' }),
    timeZone,
  });
}
