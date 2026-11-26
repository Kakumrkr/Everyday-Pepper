import type { StaffMember } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { weekDates } from './calendar-week';
import { bookedTime, myWeekDays, myWeekSummary, ownStaffMember } from './my-week';

const ZONE = 'America/New_York';
// Mon 2026-11-23 … Sun 2026-11-29; New York is UTC−5.
const dates = weekDates({ year: 2026, month: 11, day: 25 });
const at = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 10, day, hour + 5, minute)).toISOString();
const visit = (id: string, day: number, hour: number, minutes = 60) => ({
  id,
  startsAt: at(day, hour),
  endsAt: new Date(Date.parse(at(day, hour)) + minutes * 60_000).toISOString(),
});
// Mon–Fri 09–17, Thursday the whole working day away.
const hours = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
const thursdayOff = { startsAt: at(26, 9), endsAt: at(26, 17) };

describe('myWeekDays (S72.2, AC-X-190)', () => {
  it('puts each visit on its day by the business’s clock, earliest first', () => {
    const days = myWeekDays(ZONE, dates, {
      visits: [visit('b', 24, 14), visit('a', 24, 10), visit('late', 24, 23, 30)],
      hours,
      timeOff: [],
      outside: [],
    });
    expect(days).toHaveLength(7);
    expect(days[1]?.visits.map((v) => v.id)).toEqual(['a', 'b', 'late']);
    expect(days.filter((day) => day.visits.length > 0)).toHaveLength(1);
  });

  it('marks days off: no hours, or time off over all of them; partial time off is not', () => {
    const days = myWeekDays(ZONE, dates, {
      visits: [],
      hours,
      timeOff: [thursdayOff, { startsAt: at(23, 12), endsAt: at(23, 13) }],
      outside: [{ startsAt: at(25, 11), endsAt: at(25, 12) }],
    });
    expect(days.map((day) => day.off)).toEqual([false, false, false, true, false, true, true]);
    expect(days[0]?.timeOff).toEqual([{ startsAt: at(23, 12), endsAt: at(23, 13) }]);
    expect(days[2]?.outside).toEqual([{ startsAt: at(25, 11), endsAt: at(25, 12) }]);
    expect(days[0]?.working).toEqual([{ startsAt: at(23, 9), endsAt: at(23, 17) }]);
  });

  it('clips a time off over several days to each, and calls nothing off with hours unknown', () => {
    const days = myWeekDays(ZONE, dates, {
      visits: [],
      hours,
      timeOff: [{ startsAt: at(24, 0), endsAt: at(26, 0) }],
      outside: [],
    });
    expect(days.map((day) => day.off).slice(0, 4)).toEqual([false, true, true, false]);
    expect(days[1]?.timeOff).toEqual([{ startsAt: at(24, 0), endsAt: at(25, 0) }]);
    const unknown = myWeekDays(ZONE, dates, { visits: [], hours: null, timeOff: [], outside: [] });
    expect(unknown.every((day) => !day.off && day.working.length === 0)).toBe(true);
  });
});

describe('myWeekSummary (AC-X-191)', () => {
  it('says the visits, the time booked and the days off, without money', () => {
    const days = myWeekDays(ZONE, dates, {
      visits: [visit('a', 23, 9), visit('b', 24, 10, 90), visit('c', 25, 10, 30)],
      hours,
      timeOff: [thursdayOff],
      outside: [],
    });
    expect(myWeekSummary(days)).toBe('3 visits · 3 h booked · Thu, Sat, Sun off');
    const one = myWeekDays(ZONE, dates, {
      visits: [visit('a', 23, 9, 45)],
      hours: [{ weekday: 1, start: '09:00', end: '17:00' }],
      timeOff: [],
      outside: [],
    });
    expect(myWeekSummary(one)).toBe('1 visit · 45 min booked · Tue, Wed, Thu, Fri, Sat, Sun off');
  });

  it('says "No visits" for an empty week and leaves out days off it can’t know', () => {
    const days = myWeekDays(ZONE, dates, { visits: [], hours: null, timeOff: [], outside: [] });
    expect(myWeekSummary(days)).toBe('No visits');
  });
});

describe('bookedTime', () => {
  it('reads hours and minutes', () => {
    expect([bookedTime(510), bookedTime(45), bookedTime(120), bookedTime(65)]).toEqual([
      '8 h 30',
      '45 min',
      '2 h',
      '1 h 05',
    ]);
  });
});

describe('ownStaffMember (AC-X-189)', () => {
  const member = (id: string, userId: string | null, active = true) =>
    ({ id, userId, active, displayName: id }) as unknown as StaffMember;

  it('is the active staff member linked to the login, else none', () => {
    const staff = [member('a', 'u1'), member('b', 'u2', false), member('c', null)];
    expect(ownStaffMember(staff, 'u1')?.id).toBe('a');
    expect(ownStaffMember(staff, 'u2')).toBeNull();
    expect(ownStaffMember(staff, 'u3')).toBeNull();
  });
});
