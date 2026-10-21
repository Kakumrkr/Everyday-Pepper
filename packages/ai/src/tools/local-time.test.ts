import { describe, expect, it } from 'vitest';
import { daysOf, instantOf, localOf } from './local-time.js';

const NY = 'America/New_York';

describe('local time', () => {
  it('converts the business wall clock to instants and back', () => {
    expect(instantOf(NY, '2026-11-03', '10:00')).toBe('2026-11-03T15:00:00.000Z');
    expect(localOf(NY, '2026-11-03T15:00:00.000Z')).toEqual({ date: '2026-11-03', time: '10:00' });
    expect(instantOf('Asia/Kolkata', '2026-11-03', '10:00')).toBe('2026-11-03T04:30:00.000Z');
  });

  it('handles the DST weeks: a skipped time means the change, a repeated one its first instant', () => {
    // 8 March 2026: 02:00 → 03:00 in New York.
    expect(instantOf(NY, '2026-03-08', '02:30')).toBe('2026-03-08T07:00:00.000Z');
    // 1 November 2026: 01:30 happens twice; the first (EDT) is meant.
    expect(instantOf(NY, '2026-11-01', '01:30')).toBe('2026-11-01T05:30:00.000Z');
    expect(localOf(NY, '2026-11-01T06:30:00.000Z')).toEqual({ date: '2026-11-01', time: '01:30' });
  });

  it('covers whole local days, 23 or 25 hours long around a change', () => {
    expect(daysOf(NY, '2026-11-03')).toEqual({
      from: '2026-11-03T05:00:00.000Z',
      to: '2026-11-04T05:00:00.000Z',
    });
    const fallBack = daysOf(NY, '2026-11-01');
    expect(Date.parse(fallBack.to) - Date.parse(fallBack.from)).toBe(25 * 3_600_000);
    const week = daysOf(NY, '2026-03-07', 7);
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe((7 * 24 - 1) * 3_600_000);
  });
});
