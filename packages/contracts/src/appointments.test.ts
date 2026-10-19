import { describe, expect, it } from 'vitest';
import {
  clockTime,
  minutesOfDay,
  ServiceInputSchema,
  StaffColorSchema,
  StaffMemberInputSchema,
  TimeOffInputSchema,
  TimeOffQuerySchema,
  WeeklyHoursSchema,
  WorkingIntervalSchema,
} from './appointments.js';

const SERVICE_A = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';
const SERVICE_B = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819a';
const USER = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F708193';

const haircut = { name: "  Women's haircut ", durationMinutes: 60 };

describe('ServiceInputSchema', () => {
  it('applies defaults and trims', () => {
    expect(ServiceInputSchema.parse(haircut)).toEqual({
      name: "Women's haircut",
      category: null,
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: null,
      priceToCents: null,
      active: true,
    });
  });

  it('accepts a "from" price and a range', () => {
    expect(ServiceInputSchema.parse({ ...haircut, priceFromCents: 6500 })).toMatchObject({
      priceFromCents: 6500,
      priceToCents: null,
    });
    expect(
      ServiceInputSchema.parse({ ...haircut, priceFromCents: 4000, priceToCents: 6000 }),
    ).toMatchObject({ priceFromCents: 4000, priceToCents: 6000 });
  });

  it.each([
    ['an empty name', { ...haircut, name: '   ' }],
    ['a too-short duration', { ...haircut, durationMinutes: 4 }],
    ['a too-long duration', { ...haircut, durationMinutes: 721 }],
    ['a fractional duration', { ...haircut, durationMinutes: 30.5 }],
    ['a negative buffer', { ...haircut, bufferAfterMinutes: -5 }],
    ['a too-long buffer', { ...haircut, bufferBeforeMinutes: 241 }],
    ['a price in dollars', { ...haircut, priceFromCents: 65.5 }],
    ['a negative price', { ...haircut, priceFromCents: -1 }],
    ['a price over the limit', { ...haircut, priceFromCents: 10_000_001 }],
    ['a "to" price without a "from" price', { ...haircut, priceToCents: 6000 }],
    ['a "to" price equal to the "from"', { ...haircut, priceFromCents: 6000, priceToCents: 6000 }],
    ['a "to" price below the "from"', { ...haircut, priceFromCents: 6000, priceToCents: 5000 }],
    ['an unknown field', { ...haircut, tenantId: SERVICE_A }],
  ])('rejects %s', (_label, input) => {
    expect(ServiceInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('StaffMemberInputSchema', () => {
  it('applies defaults and normalises ids and colour', () => {
    expect(
      StaffMemberInputSchema.parse({
        displayName: ' Jess ',
        color: '#2A7230',
        userId: USER,
        serviceIds: [SERVICE_A.toUpperCase()],
      }),
    ).toEqual({
      displayName: 'Jess',
      color: '#2a7230',
      active: true,
      userId: USER.toLowerCase(),
      serviceIds: [SERVICE_A],
    });
    expect(StaffMemberInputSchema.parse({ displayName: 'Marco' })).toMatchObject({
      userId: null,
      serviceIds: [],
    });
  });

  it.each([
    ['an empty name', { displayName: '' }],
    ['a duplicate service', { displayName: 'Jess', serviceIds: [SERVICE_A, SERVICE_A] }],
    ['a service that is not a UUID', { displayName: 'Jess', serviceIds: ['haircut'] }],
    ['a bad colour', { displayName: 'Jess', color: 'red' }],
    ['an unknown field', { displayName: 'Jess', role: 'owner' }],
  ])('rejects %s', (_label, input) => {
    expect(StaffMemberInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts two different services', () => {
    expect(
      StaffMemberInputSchema.parse({ displayName: 'Jess', serviceIds: [SERVICE_A, SERVICE_B] })
        .serviceIds,
    ).toHaveLength(2);
  });

  it.each(['#000000', '#ffffff', '#C2361b'])('accepts the colour %s', (color) => {
    expect(StaffColorSchema.safeParse(color).success).toBe(true);
  });
});

describe('clock times', () => {
  it.each([
    ['00:00', 0],
    ['09:30', 570],
    ['23:59', 1439],
    ['24:00', 1440],
  ])('%s is %i minutes after midnight, and back', (time, minutes) => {
    expect(minutesOfDay(time)).toBe(minutes);
    expect(clockTime(minutes)).toBe(time);
  });
});

describe('WorkingIntervalSchema', () => {
  it.each([
    { weekday: 1, start: '09:00', end: '17:00' },
    { weekday: 7, start: '00:00', end: '24:00' },
  ])('accepts %j', (interval) => {
    expect(WorkingIntervalSchema.parse(interval)).toEqual(interval);
  });

  it.each([
    ['weekday 0', { weekday: 0, start: '09:00', end: '17:00' }],
    ['weekday 8', { weekday: 8, start: '09:00', end: '17:00' }],
    ['end before start', { weekday: 1, start: '17:00', end: '09:00' }],
    ['an empty interval', { weekday: 1, start: '09:00', end: '09:00' }],
    ['start 24:00', { weekday: 1, start: '24:00', end: '24:00' }],
    ['a bad time', { weekday: 1, start: '9:00', end: '17:00' }],
    ['minutes over 59', { weekday: 1, start: '09:60', end: '17:00' }],
    ['end past midnight', { weekday: 1, start: '20:00', end: '24:30' }],
  ])('rejects %s', (_label, interval) => {
    expect(WorkingIntervalSchema.safeParse(interval).success).toBe(false);
  });
});

describe('WeeklyHoursSchema', () => {
  it('sorts by weekday and start, and allows touching intervals and days off', () => {
    expect(
      WeeklyHoursSchema.parse({
        intervals: [
          { weekday: 3, start: '13:00', end: '17:00' },
          { weekday: 1, start: '09:00', end: '12:00' },
          { weekday: 3, start: '09:00', end: '13:00' },
        ],
      }),
    ).toEqual({
      intervals: [
        { weekday: 1, start: '09:00', end: '12:00' },
        { weekday: 3, start: '09:00', end: '13:00' },
        { weekday: 3, start: '13:00', end: '17:00' },
      ],
    });
    expect(WeeklyHoursSchema.parse({ intervals: [] })).toEqual({ intervals: [] });
  });

  it('allows the same hours on different days', () => {
    const intervals = [1, 2].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
    expect(WeeklyHoursSchema.parse({ intervals }).intervals).toHaveLength(2);
  });

  it.each([
    [
      'overlapping intervals',
      [
        { weekday: 2, start: '09:00', end: '13:00' },
        { weekday: 2, start: '12:00', end: '17:00' },
      ],
    ],
    [
      'the same interval twice',
      [
        { weekday: 2, start: '09:00', end: '13:00' },
        { weekday: 2, start: '09:00', end: '13:00' },
      ],
    ],
    [
      'one interval inside another',
      [
        { weekday: 5, start: '08:00', end: '18:00' },
        { weekday: 5, start: '10:00', end: '11:00' },
      ],
    ],
  ])('rejects %s', (_label, intervals) => {
    expect(WeeklyHoursSchema.safeParse({ intervals }).success).toBe(false);
  });

  it('rejects more than 42 intervals', () => {
    const intervals = Array.from({ length: 43 }, (_, i) => ({
      weekday: (i % 7) + 1,
      start: clockTime(Math.floor(i / 7) * 60),
      end: clockTime(Math.floor(i / 7) * 60 + 30),
    }));
    expect(WeeklyHoursSchema.safeParse({ intervals }).success).toBe(false);
  });
});

describe('TimeOffInputSchema', () => {
  const start = '2026-10-20T13:00:00.000Z';

  it('accepts a span in UTC', () => {
    expect(
      TimeOffInputSchema.parse({ startsAt: start, endsAt: '2026-10-21T13:00:00.000Z' }),
    ).toEqual({ startsAt: start, endsAt: '2026-10-21T13:00:00.000Z' });
  });

  it('accepts exactly the longest span', () => {
    expect(
      TimeOffInputSchema.safeParse({ startsAt: start, endsAt: '2027-10-21T13:00:00.000Z' }).success,
    ).toBe(true);
  });

  it.each([
    ['an end before the start', { startsAt: start, endsAt: '2026-10-20T12:00:00.000Z' }],
    ['an empty span', { startsAt: start, endsAt: start }],
    ['a span over a year', { startsAt: start, endsAt: '2027-10-21T13:00:01.000Z' }],
    ['a local time', { startsAt: '2026-10-20T09:00:00-04:00', endsAt: start }],
    ['a free-text reason', { startsAt: start, endsAt: '2026-10-21T13:00:00.000Z', reason: 'x' }],
  ])('rejects %s', (_label, input) => {
    expect(TimeOffInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('TimeOffQuerySchema', () => {
  it('defaults and coerces the limit', () => {
    expect(TimeOffQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(TimeOffQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it.each([{ limit: '0' }, { limit: '201' }, { from: 'yesterday' }])('rejects %j', (query) => {
    expect(TimeOffQuerySchema.safeParse(query).success).toBe(false);
  });
});
