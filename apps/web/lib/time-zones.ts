// The create-business screen's time zones (S45, AC-W1-9): the US zones first, east to west,
// then every other zone alphabetically; the browser's zone is chosen at first. Plain names for
// the zones owners and clients read (S46, AC-W8-6): "Central Time", never a zone id.

/** The seven US zones, east to west (IANA ids). */
export const US_TIME_ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
] as const;

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

/** The zone the picker starts on: the browser's, or New York when it has none. */
export const FALLBACK_TIME_ZONE = 'America/New_York';

export interface TimeZoneOption {
  value: string;
  label: string;
}

/**
 * Every zone of `all`, the US ones first, plus `browserZone` when `all` lacks it (some
 * browsers report a zone their list leaves out, e.g. `UTC`).
 */
export function orderedTimeZones(all: readonly string[], browserZone: string): TimeZoneOption[] {
  const us = new Set<string>(US_TIME_ZONES);
  const rest = [...new Set([...all, browserZone])]
    .filter((zone) => zone !== '' && !us.has(zone))
    .sort((a, b) => a.localeCompare(b, 'en'));
  return [...US_TIME_ZONES, ...rest].map((zone) => {
    const city = zone.replaceAll('_', ' ');
    const name = plainZoneName(zone);
    // "Central Time (Chicago)": the city keeps Arizona and Denver, or two Eastern cities, apart.
    return {
      value: zone,
      label: name === undefined ? city : `${name} (${city.split('/').at(-1) ?? city})`,
    };
  });
}

/** The browser's zone, or `FALLBACK_TIME_ZONE`. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === '' ? FALLBACK_TIME_ZONE : zone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}
