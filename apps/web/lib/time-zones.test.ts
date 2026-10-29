import { describe, expect, it } from 'vitest';
import { orderedTimeZones, plainZoneName, US_TIME_ZONES } from './time-zones';

describe('orderedTimeZones (S45, AC-W1-9)', () => {
  const all = [
    'Europe/London',
    'America/Chicago',
    'Asia/Tokyo',
    'America/New_York',
    'Pacific/Honolulu',
  ];

  it('puts the seven US zones first, east to west, then the rest alphabetically', () => {
    const zones = orderedTimeZones(all, 'America/Chicago').map((z) => z.value);
    expect(zones.slice(0, 7)).toEqual([...US_TIME_ZONES]);
    expect(zones.slice(7)).toEqual(['Asia/Tokyo', 'Europe/London']);
  });

  it('lists each zone once and adds a browser zone the list lacks', () => {
    const zones = orderedTimeZones(all, 'UTC').map((z) => z.value);
    expect(zones).toContain('UTC');
    expect(new Set(zones).size).toBe(zones.length);
  });

  it('labels US zones plainly with their city, others without underscores (AC-W8-6)', () => {
    const zones = orderedTimeZones(['Europe/Isle_of_Man'], 'America/New_York');
    expect(zones.slice(0, 7).map((z) => z.label)).toEqual([
      'Eastern Time (New York)',
      'Central Time (Chicago)',
      'Mountain Time (Denver)',
      'Arizona Time (Phoenix)',
      'Pacific Time (Los Angeles)',
      'Alaska Time (Anchorage)',
      'Hawaii Time (Honolulu)',
    ]);
    // The value stays the zone id: the label never changes what is stored.
    expect(zones[0]?.value).toBe('America/New_York');
    expect(zones.at(-1)).toEqual({ value: 'Europe/Isle_of_Man', label: 'Europe/Isle of Man' });
  });
});

describe('plainZoneName (S46, AC-W8-6)', () => {
  // Only zones whose clock matches the named US zone all year, daylight saving included.
  const offsetOn = (zone: string, at: number) =>
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
  const JANUARY = Date.UTC(2026, 0, 15, 12);
  const JULY = Date.UTC(2026, 6, 15, 12);
  // 8 March 2026, 2:00 AM Central: the spring change, an hour either side.
  const SPRING = [Date.UTC(2026, 2, 8, 7), Date.UTC(2026, 2, 8, 9)];

  it('names zones that share a clock alike, and only those', () => {
    const named = Intl.supportedValuesOf('timeZone').filter((z) => plainZoneName(z) !== undefined);
    const reference: Record<string, string> = {
      'Eastern Time': 'America/New_York',
      'Central Time': 'America/Chicago',
      'Mountain Time': 'America/Denver',
      'Arizona Time': 'America/Phoenix',
      'Pacific Time': 'America/Los_Angeles',
      'Alaska Time': 'America/Anchorage',
      'Hawaii Time': 'Pacific/Honolulu',
    };
    for (const zone of named) {
      const like = reference[plainZoneName(zone) ?? ''] ?? '';
      for (const at of [JANUARY, JULY, ...SPRING]) {
        expect(offsetOn(zone, at), `${zone} at ${String(at)}`).toBe(offsetOn(like, at));
      }
    }
  });

  it('keeps Phoenix apart from Denver, which changes its clocks', () => {
    expect(plainZoneName('America/Phoenix')).not.toBe(plainZoneName('America/Denver'));
    expect(offsetOn('America/Phoenix', JULY)).not.toBe(offsetOn('America/Denver', JULY));
  });

  it('has no name for UTC or a zone outside the list', () => {
    expect(plainZoneName('UTC')).toBeUndefined();
    expect(plainZoneName('America/Puerto_Rico')).toBeUndefined();
    expect(plainZoneName('Asia/Kolkata')).toBeUndefined();
  });

  it('works with the browser’s own list', () => {
    const zones = orderedTimeZones(Intl.supportedValuesOf('timeZone'), 'America/Denver');
    expect(zones.slice(0, 7).map((z) => z.value)).toEqual([...US_TIME_ZONES]);
    expect(zones.filter((z) => z.value === 'America/Denver')).toHaveLength(1);
  });
});
