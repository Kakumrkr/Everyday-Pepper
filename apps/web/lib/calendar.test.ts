import { StaffMemberSchema, type StaffMember } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  calendarHref,
  columnsFor,
  dayRange,
  dayTitle,
  hourLabel,
  layoutDay,
  readCalendarParams,
  readDate,
  sameDate,
  timeRange,
  todayIn,
} from './calendar';

const NY = 'America/New_York';
const LA = 'America/Los_Angeles';
const nov3 = { year: 2026, month: 11, day: 3 };
const STAFF_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708191';

function staffMember(id: string, active = true): StaffMember {
  return StaffMemberSchema.parse({
    id,
    displayName: `Staff ${id.slice(-2)}`,
    color: '#2a7230',
    active,
    userId: null,
    serviceIds: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('todayIn', () => {
  it("is the business's date, not the server's", () => {
    // 03:30 UTC on Nov 4 is still Nov 3 in New York and Los Angeles.
    const instant = Date.parse('2026-11-04T03:30:00Z');
    expect(todayIn(NY, instant)).toEqual(nov3);
    expect(todayIn(LA, instant)).toEqual(nov3);
    expect(todayIn('UTC', instant)).toEqual({ year: 2026, month: 11, day: 4 });
  });
});

describe('readDate', () => {
  it.each(['2026-11-03', '2000-01-01', '2100-12-31', '2028-02-29'])('accepts %s', (text) => {
    expect(readDate(text)).not.toBeNull();
  });

  it.each([
    undefined,
    '',
    '2026-11-3',
    '2026-02-30',
    '2027-02-29',
    '1999-12-31',
    '2101-01-01',
    'x',
  ])('refuses %s', (text) => {
    expect(readDate(text)).toBeNull();
  });
});

describe('readCalendarParams', () => {
  it('reads the date and staff filter, falling back to today and everyone', () => {
    expect(readCalendarParams({ date: '2026-12-01', staff: STAFF_ID.toUpperCase() }, nov3)).toEqual(
      {
        date: { year: 2026, month: 12, day: 1 },
        staffMemberId: STAFF_ID,
      },
    );
    expect(readCalendarParams({}, nov3)).toEqual({ date: nov3, staffMemberId: null });
    expect(
      readCalendarParams({ date: ['2026-12-01', '2026-12-02'], staff: 'not-an-id' }, nov3),
    ).toEqual({ date: nov3, staffMemberId: null });
  });
});

describe('calendarHref', () => {
  it('links a day, with the staff filter if any', () => {
    expect(calendarHref(nov3, null)).toBe('/calendar?date=2026-11-03');
    expect(calendarHref(nov3, STAFF_ID)).toBe(`/calendar?date=2026-11-03&staff=${STAFF_ID}`);
  });
});

describe('dayRange', () => {
  it('is local midnight to local midnight in UTC', () => {
    expect(dayRange(NY, nov3)).toEqual({
      from: '2026-11-03T05:00:00.000Z',
      to: '2026-11-04T05:00:00.000Z',
    });
  });

  it('is 25 hours on the fall-back day and 23 on the spring-forward day', () => {
    const length = (range: { from: string; to: string }) =>
      (Date.parse(range.to) - Date.parse(range.from)) / 3_600_000;
    expect(length(dayRange(NY, { year: 2026, month: 11, day: 1 }))).toBe(25);
    expect(length(dayRange(NY, { year: 2026, month: 3, day: 8 }))).toBe(23);
  });
});

describe('columnsFor', () => {
  const a = staffMember('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708101');
  const gone = staffMember('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708102', false);
  it('shows active staff, or only the chosen one (even if inactive)', () => {
    expect(columnsFor([a, gone], null)).toEqual([a]);
    expect(columnsFor([a, gone], gone.id)).toEqual([gone]);
    expect(columnsFor([a, gone], STAFF_ID)).toEqual([]);
  });
});

describe('layoutDay', () => {
  const at = (start: string, end: string) => ({
    startsAt: `2026-11-03T${start}:00.000Z`,
    endsAt: `2026-11-03T${end}:00.000Z`,
  });

  it('shows 8 am – 8 pm by default with an hour line each hour', () => {
    const layout = layoutDay(NY, nov3, []);
    expect([layout.startMinute, layout.endMinute]).toEqual([480, 1200]);
    expect(layout.hours).toHaveLength(12);
    expect(layout.hours[0]).toBe(480);
  });

  it('places items by local time as percentages of the grid', () => {
    // 15:00–16:00 UTC is 10–11 am in New York: 2 of 12 hours down, 1 hour tall.
    const { blocks } = layoutDay(NY, nov3, [at('15:00', '16:00')]);
    expect(blocks[0]?.top).toBeCloseTo((2 / 12) * 100);
    expect(blocks[0]?.height).toBeCloseTo((1 / 12) * 100);
  });

  it('widens to whole hours to fit early and late items', () => {
    // 11:30 UTC = 6:30 am; 02:15 UTC next day = 9:15 pm.
    const layout = layoutDay(NY, nov3, [
      at('11:30', '12:00'),
      { startsAt: '2026-11-04T01:30:00.000Z', endsAt: '2026-11-04T02:15:00.000Z' },
    ]);
    expect([layout.startMinute, layout.endMinute]).toEqual([360, 1320]);
  });

  it('clips an item crossing midnight to the day', () => {
    // 10 pm – 1 am local.
    const layout = layoutDay(NY, nov3, [
      { startsAt: '2026-11-04T03:00:00.000Z', endsAt: '2026-11-04T06:00:00.000Z' },
    ]);
    expect(layout.endMinute).toBe(1440);
    const block = layout.blocks[0];
    expect((block?.top ?? 0) + (block?.height ?? 0)).toBeCloseTo(100);
    // And one that started the day before.
    const before = layoutDay(NY, nov3, [
      { startsAt: '2026-11-03T03:00:00.000Z', endsAt: '2026-11-03T06:00:00.000Z' },
    ]);
    expect(before.startMinute).toBe(0);
    expect(before.blocks[0]?.top).toBe(0);
  });

  it('keeps 10 am on the 10 am line on the spring-forward day', () => {
    const march8 = { year: 2026, month: 3, day: 8 };
    // 14:00 UTC is 10 am EDT (after the change).
    const { blocks, startMinute, endMinute } = layoutDay(NY, march8, [
      { startsAt: '2026-03-08T14:00:00.000Z', endsAt: '2026-03-08T15:00:00.000Z' },
    ]);
    expect(blocks[0]?.top).toBeCloseTo(((600 - startMinute) / (endMinute - startMinute)) * 100);
  });
});

describe('labels', () => {
  it('hourLabel', () => {
    expect([0, 540, 720, 780, 1380].map(hourLabel)).toEqual([
      '12 AM',
      '9 AM',
      '12 PM',
      '1 PM',
      '11 PM',
    ]);
  });

  it('timeRange is on the business clock', () => {
    expect(timeRange(NY, '2026-11-03T15:00:00.000Z', '2026-11-03T16:30:00.000Z')).toMatch(
      /^10:00\s?–\s?11:30\sAM$/,
    );
    expect(timeRange(LA, '2026-11-03T15:00:00.000Z', '2026-11-03T16:30:00.000Z')).toMatch(
      /^7:00\s?–\s?8:30\sAM$/,
    );
  });

  it('dayTitle adds the year only for another year', () => {
    expect(dayTitle(nov3, nov3)).toBe('Tuesday, November 3');
    expect(dayTitle({ year: 2027, month: 1, day: 5 }, nov3)).toBe('Tuesday, January 5, 2027');
  });

  it('sameDate', () => {
    expect(sameDate(nov3, { ...nov3 })).toBe(true);
    expect(sameDate(nov3, { ...nov3, day: 4 })).toBe(false);
  });
});
