import type { StaffMemberId } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import {
  availableSlots,
  mergeIntervals,
  type AvailabilityQuery,
  type StaffAvailability,
} from './engine.js';
import { SERVICE_ID } from './test-arbitraries.js';

const NY = 'America/New_York';
const JESS = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198' as StaffMemberId;
const MARCO = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199' as StaffMemberId;
const at = (iso: string) => Date.parse(iso);
const times = (query: AvailabilityQuery) =>
  availableSlots(query).map((slot) => new Date(slot.start).toISOString().slice(11, 16));

const NINE_TO_FIVE = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  startMinute: 9 * 60,
  endMinute: 17 * 60,
}));

function staff(overrides: Partial<StaffAvailability> = {}): StaffAvailability {
  return {
    staffMemberId: JESS,
    active: true,
    serviceIds: [SERVICE_ID],
    hours: NINE_TO_FIVE,
    timeOff: [],
    bookings: [],
    busy: [],
    rules: {
      slotIntervalMinutes: 60,
      minimumNoticeMinutes: 0,
      maximumAdvanceDays: 90,
      maxBookingsPerDay: null,
      blackouts: [],
    },
    ...overrides,
  };
}

/** Friday 16 October 2026 in New York (EDT, UTC-4), asked on the Thursday. */
function friday(overrides: Partial<AvailabilityQuery> = {}): AvailabilityQuery {
  return {
    timeZone: NY,
    now: at('2026-10-15T12:00:00Z'),
    from: at('2026-10-16T04:00:00Z'),
    to: at('2026-10-17T04:00:00Z'),
    service: {
      id: SERVICE_ID,
      active: true,
      durationMinutes: 120,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    },
    staff: [staff()],
    ...overrides,
  };
}

describe('availableSlots', () => {
  it('offers grid starts where the whole appointment fits in working hours (local time)', () => {
    // 09:00–17:00 EDT is 13:00–21:00 UTC; a 2-hour service can start 09:00 … 15:00.
    expect(times(friday())).toEqual([
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
    ]);
  });

  it('works around an existing booking (AC-W2-1: Jess is booked 3–5 pm Friday)', () => {
    const booked = staff({
      bookings: [
        {
          start: at('2026-10-16T19:00:00Z'),
          end: at('2026-10-16T21:00:00Z'),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
        },
      ],
    });
    // 4 pm (20:00 UTC) is gone; so is anything overlapping 3–5 pm.
    expect(times(friday({ staff: [booked] }))).toEqual([
      '13:00',
      '14:00',
      '15:00',
      '16:00',
      '17:00',
    ]);
  });

  it("keeps both bookings' buffers apart", () => {
    const booked = staff({
      bookings: [
        {
          start: at('2026-10-16T17:00:00Z'),
          end: at('2026-10-16T18:00:00Z'),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 30,
        },
      ],
      rules: { ...staff().rules, slotIntervalMinutes: 30 },
    });
    const query = friday({
      staff: [booked],
      service: { ...friday().service, durationMinutes: 60, bufferBeforeMinutes: 15 },
    });
    // The booking holds 17:00–18:30 UTC; a new one needs 15 minutes before it.
    expect(times(query)).toEqual([
      ...['13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'],
      ...['19:00', '19:30', '20:00'],
    ]);
  });

  it('lets buffers reach outside working hours', () => {
    const query = friday({
      service: { ...friday().service, bufferBeforeMinutes: 30, bufferAfterMinutes: 30 },
    });
    expect(times(query)[0]).toBe('13:00');
    expect(times(query).at(-1)).toBe('19:00');
  });

  it('skips time off and outside busy time', () => {
    const query = friday({
      staff: [
        staff({
          timeOff: [{ start: at('2026-10-16T13:00:00Z'), end: at('2026-10-16T16:00:00Z') }],
          busy: [{ start: at('2026-10-16T19:30:00Z'), end: at('2026-10-16T19:45:00Z') }],
        }),
      ],
    });
    expect(times(query)).toEqual(['16:00', '17:00']);
  });

  it('respects minimum notice and maximum advance', () => {
    const now = at('2026-10-16T13:30:00Z');
    expect(
      times(
        friday({ now, staff: [staff({ rules: { ...staff().rules, minimumNoticeMinutes: 120 } })] }),
      ),
    ).toEqual(['16:00', '17:00', '18:00', '19:00']);
    // Bookable up to one day ahead: starts before 13:30 UTC on Saturday only.
    const nextDay = friday({
      now: at('2026-10-15T15:30:00Z'),
      staff: [staff({ rules: { ...staff().rules, maximumAdvanceDays: 1 } })],
    });
    expect(times(nextDay)).toEqual(['13:00', '14:00', '15:00']);
  });

  it('closes blacked-out local days, for the business or one staff member', () => {
    const closed = staff({
      rules: { ...staff().rules, blackouts: [{ startDate: '2026-10-16', endDate: '2026-10-16' }] },
    });
    expect(availableSlots(friday({ staff: [closed] }))).toEqual([]);
    const otherDay = staff({
      rules: { ...staff().rules, blackouts: [{ startDate: '2026-10-17', endDate: '2026-10-20' }] },
    });
    expect(times(friday({ staff: [otherDay] }))).toHaveLength(7);
  });

  it('closes a local day once it has the daily cap of bookings', () => {
    const booking = (iso: string) => ({
      start: at(iso),
      end: at(iso) + 30 * 60_000,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
    });
    // 23:30 EDT Friday is 03:30 UTC Saturday: it counts towards Friday.
    const capped = staff({
      bookings: [booking('2026-10-16T13:00:00Z'), booking('2026-10-17T03:30:00Z')],
      rules: { ...staff().rules, maxBookingsPerDay: 2 },
    });
    expect(availableSlots(friday({ staff: [capped] }))).toEqual([]);
    const roomForOne = staff({ ...capped, rules: { ...capped.rules, maxBookingsPerDay: 3 } });
    expect(times(friday({ staff: [roomForOne] }))).toEqual([
      '14:00',
      '15:00',
      '16:00',
      '17:00',
      '18:00',
      '19:00',
    ]);
  });

  it('offers nothing for an inactive service, an inactive staff member or one who does not offer it', () => {
    expect(availableSlots(friday({ service: { ...friday().service, active: false } }))).toEqual([]);
    expect(availableSlots(friday({ staff: [staff({ active: false })] }))).toEqual([]);
    expect(availableSlots(friday({ staff: [staff({ serviceIds: [] })] }))).toEqual([]);
  });

  it('orders slots by time, then staff member', () => {
    const query = friday({ staff: [staff({ staffMemberId: MARCO }), staff()] });
    const slots = availableSlots(query);
    expect(slots.slice(0, 2).map((s) => s.staffMemberId)).toEqual([JESS, MARCO]);
    expect(slots).toHaveLength(14);
  });

  it('caps how much it is asked about at once', () => {
    expect(() =>
      availableSlots(friday({ to: at('2026-10-16T04:00:00Z') + 63 * 86_400_000 })),
    ).toThrow(RangeError);
    expect(availableSlots(friday({ to: friday().from }))).toEqual([]);
  });

  describe('daylight saving', () => {
    const night = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday,
      startMinute: 0,
      endMinute: 4 * 60,
    }));
    const hourly = (overrides: Partial<StaffAvailability> = {}) =>
      staff({ hours: night, ...overrides });
    const oneHour = { ...friday().service, durationMinutes: 60 };

    it('has an hour less to book on the spring-forward night (00:00–04:00 is 3 hours)', () => {
      const query = friday({
        now: at('2026-03-01T00:00:00Z'),
        from: at('2026-03-08T05:00:00Z'),
        to: at('2026-03-09T04:00:00Z'),
        service: oneHour,
        staff: [hourly()],
      });
      // 00:00 EST = 05:00 UTC; the clock skips 02:00–03:00; 04:00 EDT = 08:00 UTC.
      expect(times(query)).toEqual(['05:00', '06:00', '07:00']);
    });

    it('has an hour more on the fall-back night (00:00–04:00 is 5 hours)', () => {
      const query = friday({
        now: at('2026-10-25T00:00:00Z'),
        from: at('2026-11-01T04:00:00Z'),
        to: at('2026-11-02T05:00:00Z'),
        service: oneHour,
        staff: [hourly()],
      });
      // 00:00 EDT = 04:00 UTC … 04:00 EST = 09:00 UTC; 01:00 happens twice.
      expect(times(query)).toEqual(['04:00', '05:00', '06:00', '07:00', '08:00']);
    });

    it('keeps the same wall-clock hours either side of a change', () => {
      const week = friday({
        now: at('2026-10-25T00:00:00Z'),
        from: at('2026-10-31T04:00:00Z'),
        to: at('2026-11-03T05:00:00Z'),
        service: { ...friday().service, durationMinutes: 480 },
      });
      // 09:00 local each day: 13:00 UTC on Saturday (EDT), 14:00 UTC on Sunday and Monday (EST).
      expect(availableSlots(week).map((s) => new Date(s.start).toISOString())).toEqual([
        '2026-10-31T13:00:00.000Z',
        '2026-11-01T14:00:00.000Z',
        '2026-11-02T14:00:00.000Z',
      ]);
    });

    it('does not change for Phoenix, which keeps standard time', () => {
      const query = friday({
        timeZone: 'America/Phoenix',
        now: at('2026-03-01T00:00:00Z'),
        from: at('2026-03-08T07:00:00Z'),
        to: at('2026-03-09T07:00:00Z'),
        service: oneHour,
        staff: [hourly()],
      });
      expect(times(query)).toEqual(['07:00', '08:00', '09:00', '10:00']);
    });

    it('treats an end of 24:00 as the next midnight', () => {
      const lateShift = staff({
        hours: [{ weekday: 5, startMinute: 22 * 60, endMinute: 1440 }],
      });
      const query = friday({ service: oneHour, staff: [lateShift] });
      // 22:00 and 23:00 EDT on Friday are 02:00 and 03:00 UTC on Saturday.
      expect(times(query)).toEqual(['02:00', '03:00']);
    });
  });
});

describe('mergeIntervals', () => {
  it('sorts, joins overlapping and touching intervals, and drops empty ones', () => {
    expect(
      mergeIntervals([
        { start: 50, end: 60 },
        { start: 10, end: 20 },
        { start: 20, end: 30 },
        { start: 25, end: 27 },
        { start: 40, end: 40 },
      ]),
    ).toEqual([
      { start: 10, end: 30 },
      { start: 50, end: 60 },
    ]);
  });
});
