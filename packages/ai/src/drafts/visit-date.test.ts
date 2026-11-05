import { describe, expect, it } from 'vitest';
import { visitDateWords } from './visit-date.js';

describe('visitDateWords', () => {
  const now = new Date('2026-11-05T15:00:00Z');

  it('names a recent visit by month and day, in the business’s time zone', () => {
    expect(visitDateWords('America/New_York', '2026-08-11T15:00:00Z', now)).toBe('August 11');
    // 02:00 UTC on Nov 5 is still Nov 4 in Los Angeles.
    expect(visitDateWords('America/Los_Angeles', '2026-11-05T02:00:00Z', now)).toBe('November 4');
  });

  it('adds the year once the visit was over a year ago', () => {
    expect(visitDateWords('America/New_York', '2025-11-01T15:00:00Z', now)).toBe(
      'November 1, 2025',
    );
    expect(visitDateWords('America/New_York', '2024-03-02T15:00:00Z', now)).toBe('March 2, 2024');
  });

  it('keeps a visit exactly a year back without the year', () => {
    expect(visitDateWords('America/New_York', '2025-11-05T15:00:00Z', now)).toBe('November 5');
  });
});
