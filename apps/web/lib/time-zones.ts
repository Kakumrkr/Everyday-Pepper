// The create-business screen's time zones (S45, AC-W1-9): the US zones first, east to west,
// then every other zone alphabetically; the browser's zone is chosen at first.

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
  return [...US_TIME_ZONES, ...rest].map((zone) => ({
    value: zone,
    label: zone.replaceAll('_', ' '),
  }));
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
