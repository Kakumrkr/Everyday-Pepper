import { describe, expect, it } from 'vitest';
import { birthdayLabel } from './clients';

describe('birthdayLabel (AC-W1-28)', () => {
  it('says the month and day, with the year when known', () => {
    expect(birthdayLabel({ month: 3, day: 12, year: null })).toBe('March 12');
    expect(birthdayLabel({ month: 3, day: 12, year: 1990 })).toBe('March 12, 1990');
  });

  it('keeps February 29 without a year, and the last day of a month', () => {
    expect(birthdayLabel({ month: 2, day: 29, year: null })).toBe('February 29');
    expect(birthdayLabel({ month: 12, day: 31, year: 2000 })).toBe('December 31, 2000');
  });
});
