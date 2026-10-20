import { describe, expect, it } from 'vitest';
import {
  assigneeChoices,
  assigneeFromChoice,
  assigneeLabel,
  dueAtFrom,
  dueInputs,
  dueLabel,
  TEAM,
} from './tasks';

const NY = 'America/New_York';
// Monday, November 2, 2026, 10:00 AM in New York (EST, UTC−5).
const NOW = Date.parse('2026-11-02T15:00:00Z');

describe('dueAtFrom', () => {
  it('reads a date and time on the business clock; a date alone is due at 9:00 AM', () => {
    expect(dueAtFrom(NY, '2026-11-03', '14:30')).toEqual({
      ok: true,
      dueAt: '2026-11-03T19:30:00.000Z',
    });
    expect(dueAtFrom(NY, '2026-11-03', '')).toEqual({
      ok: true,
      dueAt: '2026-11-03T14:00:00.000Z',
    });
    // Across the clock change (EDT, UTC−4, until November 1).
    expect(dueAtFrom(NY, '2026-10-30', '09:00')).toEqual({
      ok: true,
      dueAt: '2026-10-30T13:00:00.000Z',
    });
  });

  it('has no due time without a date, and refuses a malformed one', () => {
    expect(dueAtFrom(NY, '', '09:00')).toEqual({ ok: true, dueAt: null });
    expect(dueAtFrom(NY, '11/03/2026', '')).toEqual({ ok: false });
    expect(dueAtFrom(NY, '2026-11-03', '25:00')).toEqual({ ok: false });
  });
});

describe('dueInputs', () => {
  it('gives back the date and time on the business clock, or empty ones', () => {
    expect(dueInputs(NY, '2026-11-03T19:30:00.000Z')).toEqual({ day: '2026-11-03', time: '14:30' });
    expect(dueInputs(NY, null)).toEqual({ day: '', time: '' });
  });
});

describe('dueLabel', () => {
  it('names today, tomorrow and yesterday, else the date; past due is overdue', () => {
    expect(dueLabel(NY, '2026-11-02T19:00:00.000Z', NOW)).toEqual({
      text: 'Today, 2:00 PM',
      overdue: false,
    });
    expect(dueLabel(NY, '2026-11-03T14:00:00.000Z', NOW).text).toBe('Tomorrow, 9:00 AM');
    expect(dueLabel(NY, '2026-11-01T14:00:00.000Z', NOW)).toEqual({
      text: 'Yesterday, 9:00 AM',
      overdue: true,
    });
    expect(dueLabel(NY, '2026-11-06T14:00:00.000Z', NOW).text).toBe('Fri, Nov 6, 9:00 AM');
    expect(dueLabel(NY, '2026-11-02T15:00:00.000Z', NOW).overdue).toBe(true);
  });

  it('uses the business clock, not UTC, for the day', () => {
    // 11:30 PM on Monday in New York is already Tuesday in UTC.
    expect(dueLabel(NY, '2026-11-03T04:30:00.000Z', NOW).text).toBe('Today, 11:30 PM');
  });
});

describe('assignees', () => {
  const members = [
    { userId: 'u-ana', name: 'Ana' },
    { userId: 'u-priya', name: 'Priya' },
    { userId: 'u-jess', name: 'Jess' },
  ];

  it('labels a task for me, a colleague or the team', () => {
    expect(assigneeLabel('u-ana', 'u-ana', members)).toBe('You');
    expect(assigneeLabel('u-jess', 'u-ana', members)).toBe('Jess');
    expect(assigneeLabel(null, 'u-ana', members)).toBe('Team');
    // Staff do not get the member list.
    expect(assigneeLabel('u-jess', 'u-ana', null)).toBe('A colleague');
  });

  it('offers me first, the others by name, then the team', () => {
    expect(assigneeChoices('u-ana', members)).toEqual([
      { value: 'u-ana', label: 'Me' },
      { value: 'u-jess', label: 'Jess' },
      { value: 'u-priya', label: 'Priya' },
      { value: TEAM, label: 'Anyone on the team' },
    ]);
    expect(assigneeFromChoice(TEAM)).toBeNull();
    expect(assigneeFromChoice('u-jess')).toBe('u-jess');
  });
});
