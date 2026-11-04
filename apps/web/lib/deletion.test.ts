import { describe, expect, it } from 'vitest';
import { deletionDayLabel } from './deletion';

describe('deletionDayLabel (S51.2)', () => {
  it('names the day in the business’s time zone', () => {
    // 03:00 UTC is still the evening before in Chicago.
    expect(deletionDayLabel('2099-12-05T03:00:00.000Z', 'America/Chicago')).toBe(
      'Friday, December 4',
    );
    expect(deletionDayLabel('2099-12-05T03:00:00.000Z', 'UTC')).toBe('Saturday, December 5');
  });
});
