import { StaffMemberSchema, type StaffMember, type WorkingInterval } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  clampStart,
  dropLabel,
  dropProblem,
  layoutWeek,
  lineAt,
  minuteAt,
  notWorking,
  startAt,
  weekDates,
  weekdayHeading,
  weekRange,
  weekStaffMember,
  weekStart,
  weekTitle,
  workingSpans,
} from './calendar-week';

const NY = 'America/New_York';
// Wednesday, November 25, 2026.
const nov25 = { year: 2026, month: 11, day: 25 };
const mon = { year: 2026, month: 11, day: 23 };
const OWN = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708101';
const OTHER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708102';
const OFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708103';
const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199';

function staffMember(id: string, active = true, userId: string | null = null): StaffMember {
  return StaffMemberSchema.parse({
    id,
    displayName: `Staff ${id.slice(-2)}`,
    color: '#2a7230',
    active,
    userId,
    serviceIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

function interval(weekday: number, start: string, end: string): WorkingInterval {
  return { weekday, start, end };
}

describe('weekStart and weekDates', () => {
  it('starts on the Monday of the date (Monday first, like working hours)', () => {
    expect(weekStart(nov25)).toEqual(mon);
    expect(weekStart(mon)).toEqual(mon);
    expect(weekStart({ year: 2026, month: 11, day: 29 })).toEqual(mon); // Sunday
  });

  it('is seven days across a month and a year end', () => {
    const dates = weekDates({ year: 2026, month: 12, day: 31 });
    expect(dates).toHaveLength(7);
    expect(dates[0]).toEqual({ year: 2026, month: 12, day: 28 });
    expect(dates[6]).toEqual({ year: 2027, month: 1, day: 3 });
  });
});

describe('weekRange', () => {
  it("is the business's Monday midnight to the next Monday's", () => {
    expect(weekRange(NY, nov25)).toEqual({
      from: '2026-11-23T05:00:00.000Z',
      to: '2026-11-30T05:00:00.000Z',
    });
  });

  it('keeps local midnights across a clock change (a week of 167 hours)', () => {
    const range = weekRange(NY, { year: 2026, month: 3, day: 10 });
    expect(range.from).toBe('2026-03-09T04:00:00.000Z');
    expect(range.to).toBe('2026-03-16T04:00:00.000Z');
  });
});

describe('weekTitle and weekdayHeading', () => {
  it('names the week in words, the year only when it is not this one', () => {
    expect(weekTitle(nov25, nov25)).toBe('Nov 23 – 29');
    expect(weekTitle({ year: 2026, month: 12, day: 1 }, nov25)).toBe('Nov 30 – Dec 6');
    expect(weekTitle({ year: 2027, month: 1, day: 1 }, nov25)).toBe('Dec 28, 2026 – Jan 3, 2027');
  });

  it('heads a day with its short weekday and number', () => {
    expect(weekdayHeading(nov25)).toEqual({
      weekday: 'Wed',
      day: '25',
      full: 'Wednesday, November 25',
    });
  });
});

describe('weekStaffMember', () => {
  const staff = [staffMember(OTHER), staffMember(OWN, true, USER), staffMember(OFF, false)];

  it('shows the one asked for', () => {
    expect(weekStaffMember(staff, OTHER, { role: 'staff', userId: USER })?.id).toBe(OTHER);
  });

  it("opens staff on their own week, owners on the first active member's", () => {
    expect(weekStaffMember(staff, null, { role: 'staff', userId: USER })?.id).toBe(OWN);
    expect(weekStaffMember(staff, null, { role: 'owner', userId: USER })?.id).toBe(OTHER);
  });

  it('falls back to the first active member for an unknown or switched-off one', () => {
    expect(weekStaffMember(staff, OFF, { role: 'owner', userId: USER })?.id).toBe(OTHER);
    expect(
      weekStaffMember(staff, OWN.replace('01', '77'), { role: 'manager', userId: USER })?.id,
    ).toBe(OTHER);
  });

  it('is null without anyone active', () => {
    expect(
      weekStaffMember([staffMember(OFF, false)], null, { role: 'owner', userId: USER }),
    ).toBeNull();
  });
});

describe('workingSpans and notWorking', () => {
  // Tuesdays and Wednesdays 9–5, with a lunch break on Wednesday.
  const hours = [
    interval(2, '09:00', '17:00'),
    interval(3, '09:00', '12:00'),
    interval(3, '13:00', '17:00'),
  ];
  const dates = weekDates(nov25);

  it("are the week's working hours as instants", () => {
    const spans = workingSpans(NY, dates, hours);
    expect(spans).toEqual([
      { startsAt: '2026-11-24T14:00:00.000Z', endsAt: '2026-11-24T22:00:00.000Z' },
      { startsAt: '2026-11-25T14:00:00.000Z', endsAt: '2026-11-25T17:00:00.000Z' },
      { startsAt: '2026-11-25T18:00:00.000Z', endsAt: '2026-11-25T22:00:00.000Z' },
    ]);
  });

  it('shades everything else, whole days off included, and time off', () => {
    const off = notWorking(NY, dates, hours, [
      { startsAt: '2026-11-24T19:00:00.000Z', endsAt: '2026-11-24T20:00:00.000Z' },
    ]);
    // Monday is a day off: the whole day.
    expect(off[0]).toEqual([
      { startsAt: '2026-11-23T05:00:00.000Z', endsAt: '2026-11-24T05:00:00.000Z' },
    ]);
    // Tuesday: before 9, 2–3 pm time off, after 5.
    expect(off[1]).toEqual([
      { startsAt: '2026-11-24T05:00:00.000Z', endsAt: '2026-11-24T14:00:00.000Z' },
      { startsAt: '2026-11-24T19:00:00.000Z', endsAt: '2026-11-24T20:00:00.000Z' },
      { startsAt: '2026-11-24T22:00:00.000Z', endsAt: '2026-11-25T05:00:00.000Z' },
    ]);
    // Wednesday: before 9, lunch, after 5.
    expect(off[2]).toHaveLength(3);
    expect(off[2]?.[1]).toEqual({
      startsAt: '2026-11-25T17:00:00.000Z',
      endsAt: '2026-11-25T18:00:00.000Z',
    });
  });

  it('merges time off that touches the off hours, and clips a long one to each day', () => {
    const off = notWorking(NY, dates, hours, [
      // Tuesday 4 pm to Wednesday 10 am.
      { startsAt: '2026-11-24T21:00:00.000Z', endsAt: '2026-11-25T15:00:00.000Z' },
    ]);
    expect(off[1]?.at(-1)).toEqual({
      startsAt: '2026-11-24T21:00:00.000Z',
      endsAt: '2026-11-25T05:00:00.000Z',
    });
    expect(off[2]?.[0]).toEqual({
      startsAt: '2026-11-25T05:00:00.000Z',
      endsAt: '2026-11-25T15:00:00.000Z',
    });
  });

  it('is nothing when the hours are unknown (the api decides alone)', () => {
    expect(notWorking(NY, dates, null, [])).toEqual([[], [], [], [], [], [], []]);
  });
});

describe('layoutWeek', () => {
  const dates = weekDates(nov25);

  it('puts each item on its day, on one grid of hours for the week', () => {
    const layout = layoutWeek(NY, dates, [
      // Monday 7–8 am, Friday 9–10 pm: the grid widens to 7 am – 10 pm.
      { startsAt: '2026-11-23T12:00:00.000Z', endsAt: '2026-11-23T13:00:00.000Z' },
      { startsAt: '2026-11-28T02:00:00.000Z', endsAt: '2026-11-28T03:00:00.000Z' },
    ]);
    expect(layout.startMinute).toBe(7 * 60);
    expect(layout.endMinute).toBe(22 * 60);
    expect(layout.days[0]?.blocks).toHaveLength(1);
    expect(layout.days[0]?.blocks[0]?.item.startsAt).toBe('2026-11-23T12:00:00.000Z');
    expect(layout.days[0]?.blocks[0]?.top).toBe(0);
    expect(layout.days[0]?.blocks[0]?.height).toBeCloseTo((60 / 900) * 100);
    expect(layout.days[4]?.blocks[0]?.top).toBeCloseTo(((14 * 60) / 900) * 100);
    expect(layout.days[1]?.blocks).toEqual([]);
  });

  it('widens to fit the working hours too, and clips shading to the grid', () => {
    const layout = layoutWeek(
      NY,
      dates,
      [],
      [{ startsAt: '2026-11-24T11:30:00.000Z', endsAt: '2026-11-24T22:00:00.000Z' }],
      [{ startsAt: '2026-11-24T05:00:00.000Z', endsAt: '2026-11-24T11:30:00.000Z' }],
    );
    expect(layout.startMinute).toBe(6 * 60);
    expect(layout.days[1]?.shade).toEqual([{ top: 0, height: (30 / 840) * 100 }]);
  });

  it('shows a visit across midnight on both days', () => {
    const layout = layoutWeek(NY, dates, [
      { startsAt: '2026-11-25T04:30:00.000Z', endsAt: '2026-11-25T05:30:00.000Z' },
    ]);
    expect(layout.days[1]?.blocks).toHaveLength(1);
    expect(layout.days[2]?.blocks).toHaveLength(1);
    expect(layout.startMinute).toBe(0);
    expect(layout.endMinute).toBe(1440);
  });
});

describe('lineAt', () => {
  it("places the now-line with the grid's own hours, so it meets the blocks beside it", () => {
    // A 7 am booking widens the grid to 7 am – 8 pm (780 minutes); noon is 300 minutes in.
    const layout = layoutWeek(NY, weekDates(nov25), [
      { startsAt: '2026-11-25T12:00:00.000Z', endsAt: '2026-11-25T13:00:00.000Z' },
    ]);
    expect(lineAt(NY, nov25, '2026-11-25T17:00:00.000Z', layout)).toBeCloseTo((300 / 780) * 100);
  });

  it('is nothing outside the grid', () => {
    const layout = { startMinute: 8 * 60, endMinute: 20 * 60 };
    expect(lineAt(NY, nov25, '2026-11-25T11:00:00.000Z', layout)).toBeNull();
    expect(lineAt(NY, nov25, '2026-11-26T02:00:00.000Z', layout)).toBeNull();
  });
});

describe('minuteAt and clampStart', () => {
  it('turns a point on the grid into a minute in 15-minute steps', () => {
    // 8 am – 8 pm grid, 720 minutes; 0.5 is 2 pm.
    expect(minuteAt(0.5, 480, 1200)).toBe(840);
    expect(minuteAt(0.5 + 7 / 720, 480, 1200)).toBe(840);
    expect(minuteAt(0.5 + 8 / 720, 480, 1200)).toBe(855);
    expect(minuteAt(-1, 480, 1200)).toBe(480);
    expect(minuteAt(2, 480, 1200)).toBe(1200);
  });

  it('keeps the whole visit on the grid', () => {
    expect(clampStart(1170, 60, 480, 1200)).toBe(1140);
    expect(clampStart(400, 60, 480, 1200)).toBe(480);
    expect(clampStart(600, 60, 480, 1200)).toBe(600);
  });
});

describe('startAt and dropLabel', () => {
  it("is the instant of a minute on a day of the business's clock", () => {
    expect(startAt(NY, { year: 2026, month: 11, day: 24 }, 15 * 60 + 15)).toBe(
      '2026-11-24T20:15:00.000Z',
    );
  });

  it('says the day and time in a few words', () => {
    expect(dropLabel(NY, '2026-11-24T20:15:00.000Z')).toBe('Tue 3:15 PM');
  });
});

describe('dropProblem', () => {
  const now = Date.parse('2026-11-25T15:00:00.000Z');
  const target = { startsAt: '2026-11-26T15:00:00.000Z', endsAt: '2026-11-26T16:00:00.000Z' };

  it('is none for a free working time', () => {
    expect(dropProblem(target, { bookings: [], off: [], now })).toBeNull();
  });

  it('marks a time that overlaps another booking', () => {
    expect(
      dropProblem(target, {
        bookings: [{ startsAt: '2026-11-26T15:30:00.000Z', endsAt: '2026-11-26T16:30:00.000Z' }],
        off: [],
        now,
      }),
    ).toBe('taken');
  });

  it('lets a visit end where the next begins', () => {
    expect(
      dropProblem(target, {
        bookings: [{ startsAt: '2026-11-26T16:00:00.000Z', endsAt: '2026-11-26T17:00:00.000Z' }],
        off: [{ startsAt: '2026-11-26T05:00:00.000Z', endsAt: '2026-11-26T15:00:00.000Z' }],
        now,
      }),
    ).toBeNull();
  });

  it('marks a time outside the working hours, and one in the past', () => {
    expect(
      dropProblem(target, {
        bookings: [],
        off: [{ startsAt: '2026-11-26T15:45:00.000Z', endsAt: '2026-11-27T05:00:00.000Z' }],
        now,
      }),
    ).toBe('off');
    expect(
      dropProblem(
        { startsAt: '2026-11-25T14:00:00.000Z', endsAt: '2026-11-25T15:00:00.000Z' },
        { bookings: [], off: [], now },
      ),
    ).toBe('past');
  });

  it('says the past before a clash, a clash before the hours', () => {
    const past = { startsAt: '2026-11-25T14:00:00.000Z', endsAt: '2026-11-25T15:00:00.000Z' };
    expect(dropProblem(past, { bookings: [past], off: [past], now })).toBe('past');
    expect(dropProblem(target, { bookings: [target], off: [target], now })).toBe('taken');
  });
});
