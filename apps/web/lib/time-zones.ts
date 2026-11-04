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

// The plain names live in `@pepper/contracts` (S51.2), shared with the business export.
import { plainZoneName } from '@pepper/contracts';

export { plainZoneName };

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
