import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  dayBeforeHint,
  leadLabel,
  remindersSummary,
  sameDayGoes,
  sameDayHint,
  savedNote,
  textsHint,
  withPatch,
} from './reminder-settings';

const on = DEFAULT_REMINDER_SETTINGS;
const with_ = (patch: Partial<ReminderSettings>): ReminderSettings => ({ ...on, ...patch });

describe('Texts and reminders wording (AC-X-77)', () => {
  it('names the lead in hours', () => {
    expect(leadLabel(1)).toBe('1 hour');
    expect(leadLabel(3)).toBe('3 hours');
  });

  it('sums up what a client gets before a visit', () => {
    expect(remindersSummary(on)).toBe('A reminder the day before and a text 2 hours ahead');
    expect(remindersSummary(with_({ sameDay: false }))).toBe('A reminder the day before');
    expect(remindersSummary(with_({ dayBefore: false, sameDayLeadHours: 1 }))).toBe(
      'A text 1 hour ahead',
    );
    expect(remindersSummary(with_({ dayBefore: false, sameDay: false }))).toBe(
      'No reminders before a visit',
    );
  });

  it('with texts off, keeps only the email the day before', () => {
    const off = with_({ texts: false });
    expect(sameDayGoes(off)).toBe(false);
    expect(remindersSummary(off)).toBe('An email reminder the day before');
    expect(remindersSummary(with_({ texts: false, dayBefore: false }))).toBe(
      'No reminders before a visit',
    );
    expect(textsHint(off)).toContain('No texts go to clients');
    expect(dayBeforeHint(off)).toContain('by email while texts are off');
    expect(sameDayHint(off)).toBe('A text only, so it waits while texts are off.');
  });

  it('hints with texts on', () => {
    expect(textsHint(on)).toContain('said yes on your booking page');
    expect(dayBeforeHint(on)).toContain('By text when they said yes, else by email');
    expect(sameDayHint(with_({ sameDayLeadHours: 3 }))).toBe(
      'A short text 3 hours before they come in.',
    );
  });

  it('says what each save changed', () => {
    expect(savedNote({ texts: false }, with_({ texts: false }))).toBe(
      'Saved. No texts go to clients.',
    );
    expect(savedNote({ texts: true }, on)).toBe('Saved. Texts to clients are on.');
    expect(savedNote({ dayBefore: false }, with_({ dayBefore: false }))).toBe(
      'Saved. No reminder the day before.',
    );
    expect(savedNote({ dayBefore: true }, on)).toBe(
      'Saved. Clients get a reminder the day before.',
    );
    expect(savedNote({ sameDay: false }, with_({ sameDay: false }))).toBe(
      'Saved. No text on the day.',
    );
    expect(savedNote({ sameDay: true }, on)).toBe('Saved. Clients get a text 2 hours ahead.');
    expect(savedNote({ sameDayLeadHours: 1 }, with_({ sameDayLeadHours: 1 }))).toBe(
      'Saved. The text on the day goes 1 hour ahead.',
    );
  });

  it('applies a change over the settings, keeping the rest', () => {
    expect(withPatch(on, { sameDayLeadHours: 3 })).toEqual(with_({ sameDayLeadHours: 3 }));
    expect(withPatch(on, { texts: false })).toEqual(with_({ texts: false }));
  });
});
