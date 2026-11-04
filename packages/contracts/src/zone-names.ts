// Time zones in words (DESIGN.md §6: no zone ids), for the screens (S46, AC-W8-6) and the
// business export's README (S51.2, AC-W1-44).

/**
 * The plain names of zones that keep the same clock as the US zone named, daylight saving
 * included. Arizona (Phoenix) has no daylight saving, so it is not "Mountain Time" in summer and
 * gets its own name; a zone whose rules differ from all of these (Puerto Rico, Indiana's
 * Tell City...) is left to the city fallback rather than equated.
 */
const ZONE_NAMES: Readonly<Record<string, string>> = {
  'America/New_York': 'Eastern Time',
  'America/Detroit': 'Eastern Time',
  'America/Indiana/Indianapolis': 'Eastern Time',
  'America/Kentucky/Louisville': 'Eastern Time',
  'America/Toronto': 'Eastern Time',
  'US/Eastern': 'Eastern Time',
  'America/Chicago': 'Central Time',
  'America/Winnipeg': 'Central Time',
  'US/Central': 'Central Time',
  'America/Denver': 'Mountain Time',
  'America/Boise': 'Mountain Time',
  'America/Edmonton': 'Mountain Time',
  'US/Mountain': 'Mountain Time',
  'America/Phoenix': 'Arizona Time',
  'US/Arizona': 'Arizona Time',
  'America/Los_Angeles': 'Pacific Time',
  'America/Vancouver': 'Pacific Time',
  'US/Pacific': 'Pacific Time',
  'America/Anchorage': 'Alaska Time',
  'America/Juneau': 'Alaska Time',
  'US/Alaska': 'Alaska Time',
  'Pacific/Honolulu': 'Hawaii Time',
  'US/Hawaii': 'Hawaii Time',
};

/**
 * A zone's plain name ("Central Time"), or `undefined` when it has none here; callers fall
 * back to the city (`localTimeLabel`). Only the label: the stored zone never changes.
 */
export function plainZoneName(timeZone: string): string | undefined {
  return ZONE_NAMES[timeZone];
}

/**
 * The business's clock in words (DESIGN.md §6, no zone ids): its plain name ("Central Time",
 * S46), else its city (`Europe/Paris` → "Paris time"), "UTC", or an offset zone by its offset
 * ("GMT-5": Etc's own names invert the sign), the offset in force `at` that moment (now).
 */
export function localTimeLabel(timeZone: string, at: number = Date.now()): string {
  const plain = plainZoneName(timeZone);
  if (plain !== undefined) return plain;
  if (
    ['UTC', 'GMT', 'Etc/UTC', 'Etc/GMT', 'Etc/UCT', 'Etc/Universal', 'Etc/Zulu'].includes(timeZone)
  ) {
    return 'UTC';
  }
  if (timeZone.startsWith('Etc/') || !timeZone.includes('/')) {
    const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    return offset ?? timeZone;
  }
  const city = timeZone.split('/').at(-1)?.replaceAll('_', ' ') ?? timeZone;
  return `${city} time`;
}
