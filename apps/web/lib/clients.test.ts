import { describe, expect, it } from 'vitest';
import {
  birthdayFromForm,
  birthdayLabel,
  deleteSentence,
  mergeSentence,
  tagsFromText,
  tagsText,
  upcomingSentence,
} from './clients';

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

describe('tags in the editor (AC-W1-32)', () => {
  it('reads commas, tidies and drops repeats ignoring case', () => {
    expect(tagsFromText(' VIP, vip,  color   client ,, ')).toEqual(['VIP', 'color client']);
    expect(tagsFromText('')).toEqual([]);
    expect(tagsText(['VIP', 'Color'])).toBe('VIP, Color');
  });

  it('refuses more than 20 tags or one over 40 characters', () => {
    expect(
      tagsFromText(Array.from({ length: 21 }, (_, i) => `t${String(i)}`).join(',')),
    ).toBeNull();
    expect(tagsFromText('x'.repeat(41))).toBeNull();
  });
});

describe('birthday in the editor (AC-W1-32)', () => {
  it('is none when empty, and a date with or without its year', () => {
    expect(birthdayFromForm('', '', '')).toBeNull();
    expect(birthdayFromForm('2', '29', '')).toEqual({ month: 2, day: 29, year: null });
    expect(birthdayFromForm('12', ' 31 ', '1990')).toEqual({ month: 12, day: 31, year: 1990 });
  });

  it('refuses a day the month doesn’t have, a missing part or a bad year', () => {
    expect(birthdayFromForm('2', '29', '2023')).toBe('invalid');
    expect(birthdayFromForm('4', '31', '')).toBe('invalid');
    expect(birthdayFromForm('4', '', '')).toBe('invalid');
    expect(birthdayFromForm('', '', '1990')).toBe('invalid');
    expect(birthdayFromForm('4', '3x', '')).toBe('invalid');
    expect(birthdayFromForm('4', '3', '90')).toBe('invalid');
  });
});

describe('merge and delete sentences (AC-W1-30, AC-W1-31)', () => {
  const none = { upcomingVisits: 0, pastVisits: 0, waitlistEntries: 0, notes: 0 };

  it('names what moves to the client kept', () => {
    expect(
      mergeSentence('Dee H.', 'Dee Hart', { ...none, pastVisits: 2, upcomingVisits: 1, notes: 1 }),
    ).toBe(
      'Dee H.’s 3 visits and 1 note move to Dee Hart. Their email, phone, birthday and tags fill what Dee Hart is missing, then Dee H. is removed. This can’t be undone.',
    );
    expect(mergeSentence('Dee H.', 'Dee Hart', none)).toMatch(/^Dee H\. has no visits or notes/);
    expect(
      mergeSentence('A', 'B', { ...none, pastVisits: 1, waitlistEntries: 2, notes: 3 }),
    ).toMatch(/^A’s 1 visit, 2 waitlist entries and 3 notes move to B\./);
    expect(mergeSentence('A', 'B', { ...none, upcomingVisits: 1 })).toMatch(
      /^A’s 1 visit moves to B\./,
    );
  });

  it('says what a deletion keeps and forgets, and refuses with visits coming up', () => {
    expect(deleteSentence('Zoe', { ...none, pastVisits: 1, notes: 2 })).toBe(
      '1 past visit stays in your history as “Deleted client”. I’ll forget Zoe’s name, email, phone, tags and birthday and 2 notes about them, everywhere I keep them. This can’t be undone.',
    );
    expect(deleteSentence('Zoe', none)).toBe(
      'I’ll forget Zoe’s name, email, phone, tags and birthday, everywhere I keep them. This can’t be undone.',
    );
    expect(deleteSentence('Zoe', { ...none, upcomingVisits: 1 })).toBeNull();
    expect(upcomingSentence('Zoe', { ...none, upcomingVisits: 2 })).toBe(
      'Zoe has 2 visits coming up. Cancel or move them first, then delete.',
    );
  });
});
