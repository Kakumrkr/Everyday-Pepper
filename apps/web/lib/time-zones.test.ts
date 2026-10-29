import { describe, expect, it } from 'vitest';
import { orderedTimeZones, US_TIME_ZONES } from './time-zones';

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

  it('labels zones without underscores', () => {
    expect(orderedTimeZones([], 'America/New_York')[0]).toEqual({
      value: 'America/New_York',
      label: 'America/New York',
    });
  });

  it('works with the browser’s own list', () => {
    const zones = orderedTimeZones(Intl.supportedValuesOf('timeZone'), 'America/Denver');
    expect(zones.slice(0, 7).map((z) => z.value)).toEqual([...US_TIME_ZONES]);
    expect(zones.filter((z) => z.value === 'America/Denver')).toHaveLength(1);
  });
});
