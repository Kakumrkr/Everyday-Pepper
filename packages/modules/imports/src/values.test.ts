import { describe, expect, it } from 'vitest';
import {
  readBirthday,
  readDate,
  readDuration,
  readPrice,
  readStatus,
  readTags,
  readTime,
} from './values.js';

describe('readDate (AC-W1-22)', () => {
  it.each([
    ['2026-01-05', { year: 2026, month: 1, day: 5 }, null, null],
    ['2026-01-05T14:30:00', { year: 2026, month: 1, day: 5 }, 870, null],
    ['2026-01-05T14:30:00Z', { year: 2026, month: 1, day: 5 }, 870, 0],
    ['2026-01-05 09:15-05:00', { year: 2026, month: 1, day: 5 }, 555, -300],
    ['2026-01-05T09:15:00.000+0530', { year: 2026, month: 1, day: 5 }, 555, 330],
    ['1/5/2026', { year: 2026, month: 1, day: 5 }, null, null],
    ['01/05/26', { year: 2026, month: 1, day: 5 }, null, null],
    ['1/5/2026 2:30 PM', { year: 2026, month: 1, day: 5 }, 870, null],
    ['1/5/2026 14:30', { year: 2026, month: 1, day: 5 }, 870, null],
    ['Jan 5, 2026', { year: 2026, month: 1, day: 5 }, null, null],
    ['January 5th 2026 at 9am', { year: 2026, month: 1, day: 5 }, 540, null],
    ['Mon, Jan 5, 2026, 12:00 AM', { year: 2026, month: 1, day: 5 }, 0, null],
    ['5 Jan 2026', { year: 2026, month: 1, day: 5 }, null, null],
  ])('%s', (cell, date, minute, offset) => {
    expect(readDate(cell)).toEqual({ date, minute, offset });
  });

  it.each([
    '',
    'soon',
    '2026-02-30',
    '13/45/2026',
    '1/5/2026 25:00',
    'Jan 32, 2026',
    '2026-01-05T24:10',
  ])('refuses %j', (cell) => {
    expect(readDate(cell)).toBeNull();
  });
});

describe('readTime', () => {
  it.each([
    ['2:30 PM', 870],
    ['2:30pm', 870],
    ['2 pm', 840],
    ['12:00 AM', 0],
    ['12 PM', 720],
    ['14:30', 870],
    ['09:05:00', 545],
    ['9.30 a.m.', 570],
  ])('%s → %i', (cell, minute) => {
    expect(readTime(cell)).toBe(minute);
  });

  it.each(['14', '13 PM', '2:75', 'noon'])('refuses %j', (cell) => {
    expect(readTime(cell)).toBeNull();
  });
});

describe('readDuration', () => {
  it.each([
    ['45', 45],
    ['45 min', 45],
    ['90 minutes', 90],
    ['1h', 60],
    ['1.5 hours', 90],
    ['1h 30m', 90],
    ['1 hr 30 mins', 90],
    ['1:15', 75],
  ])('%s → %i', (cell, minutes) => {
    expect(readDuration(cell)).toBe(minutes);
  });

  it('refuses words', () => {
    expect(readDuration('a while')).toBeNull();
  });
});

describe('readPrice', () => {
  it.each([
    ['$45', 4500],
    ['45.5', 4550],
    ['1,200.00', 120000],
    ['USD 30', 3000],
    ['0', 0],
  ])('%s → %i', (cell, cents) => {
    expect(readPrice(cell)).toBe(cents);
  });

  it.each(['-5', 'free', '45.123', '200000'])('refuses %j', (cell) => {
    expect(readPrice(cell)).toBeNull();
  });
});

describe('readStatus', () => {
  it.each([
    ['Completed', 'kept'],
    ['Checked out', 'kept'],
    ['Confirmed', 'kept'],
    ['', 'kept'],
    ['No Show', 'no_show'],
    ['no-show', 'no_show'],
    ['Cancelled', 'cancelled'],
    ['canceled by client', 'cancelled'],
    ['Late cancel', 'cancelled'],
  ])('%j → %s', (cell, status) => {
    expect(readStatus(cell)).toBe(status);
  });
});

describe('readBirthday (AC-W1-25)', () => {
  it.each([
    ['1990-04-12', { month: 4, day: 12, year: 1990 }],
    ['4/12/1990', { month: 4, day: 12, year: 1990 }],
    ['04/12', { month: 4, day: 12, year: null }],
    ['--04-12', { month: 4, day: 12, year: null }],
    ['April 12', { month: 4, day: 12, year: null }],
    ['12 Apr', { month: 4, day: 12, year: null }],
    ['Apr 12th, 1990', { month: 4, day: 12, year: 1990 }],
    ['1900-04-12', { month: 4, day: 12, year: null }],
    ['2/29', { month: 2, day: 29, year: null }],
  ])('%s', (cell, birthday) => {
    expect(readBirthday(cell)).toEqual(birthday);
  });

  it.each(['', '2/29/1990', '13/1', 'April 31', 'sometime', '4/12/2999'])('refuses %j', (cell) => {
    expect(readBirthday(cell)).toBeNull();
  });
});

describe('readTags (AC-W1-25)', () => {
  it('splits, tidies and drops repeats ignoring case', () => {
    expect(readTags(['VIP, Regular;  color  client', 'vip|New'])).toEqual({
      tags: ['VIP', 'Regular', 'color client', 'New'],
      cut: false,
    });
  });

  it('says when it left tags out: too long, or past 20', () => {
    expect(readTags(['x'.repeat(41)]).cut).toBe(true);
    const many = readTags([Array.from({ length: 25 }, (_, i) => `t${String(i)}`).join(',')]);
    expect(many.tags).toHaveLength(20);
    expect(many.cut).toBe(true);
  });
});
