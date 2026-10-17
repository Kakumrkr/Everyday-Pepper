import { describe, expect, it } from 'vitest';
import { usagePeriodOf } from './usage-period.js';

describe('usagePeriodOf', () => {
  it.each([
    ['2026-01-01T00:00:00.000Z', '2026-01'],
    ['2026-10-31T23:59:59.999Z', '2026-10'],
    ['2026-12-31T23:59:59.999Z', '2026-12'],
  ])('%s → %s', (instant, period) => {
    expect(usagePeriodOf(new Date(instant))).toBe(period);
  });

  it('uses UTC, not the server time zone: 8 pm in New York on Oct 31 is November', () => {
    expect(usagePeriodOf(new Date('2026-10-31T20:00:00-04:00'))).toBe('2026-11');
  });

  it('rejects an invalid date', () => {
    expect(() => usagePeriodOf(new Date('nope'))).toThrow(RangeError);
  });
});
