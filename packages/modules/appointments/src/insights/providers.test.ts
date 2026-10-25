import { describe, expect, it } from 'vitest';
import {
  ANA,
  COLOR,
  CUT,
  EVERY_DAY,
  JESS,
  KOLKATA,
  MARIA,
  PHOENIX,
  SAM,
  at,
  booking,
  hours,
  snapshot,
  staffMember,
} from './fixtures.js';
import {
  findInsights,
  noShowPattern,
  rebookingDue,
  scheduleGaps,
  staffOverload,
  waitlistMatch,
} from './providers.js';
import { feedDedupeKey as dedupeKey } from '@pepper/db';
import type { BookingId } from '@pepper/contracts';
import type { InsightCandidate } from './types.js';

// The insight fixtures (S35, playbook §2 "insight correctness 100% on the fixtures, across time
// zones and a DST change"). Every expected instant is written out in UTC on purpose: the
// fixtures check the providers' local-time arithmetic, so they must not reuse it.

const iso = (ms: number) => new Date(ms).toISOString();
const only = (items: InsightCandidate[]) => {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error('expected one item');
  return item;
};

describe('schedule_gaps', () => {
  // Monday 2026-11-02 in New York (EST, UTC-5); Jess works Mondays 9–17 only.
  const monday = (bookings = [] as ReturnType<typeof booking>[], now = '2026-11-02T13:00:00Z') =>
    scheduleGaps.find(
      snapshot({
        now: at(now),
        staff: [staffMember(JESS, { hours: hours([1], 9, 17) })],
        bookings,
      }),
    );
  const nineToTen = () => booking('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z');
  const noonToOne = () => booking('2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z');

  it('finds the open gaps of a working day, one item per staff member and day', () => {
    const item = only(monday([nineToTen(), noonToOne()]));
    expect(item).toMatchObject({
      kind: 'schedule_gaps',
      subjectKey: `staff:${JESS}`,
      day: '2026-11-02',
      audienceStaffId: JESS,
      subjects: { staffMemberId: JESS, clientId: null, bookingId: null, serviceId: null },
      payload: {
        gapCount: 2,
        openMinutes: 360,
        longestStartsAt: '2026-11-02T18:00:00.000Z',
        longestEndsAt: '2026-11-02T22:00:00.000Z',
      },
    });
    expect(iso(item.expiresAt)).toBe('2026-11-02T22:00:00.000Z');
    expect(dedupeKey(item)).toBe(`schedule_gaps:staff:${JESS}:2026-11-02`);
  });

  it('skips gaps shorter than the minimum and counts one exactly at it', () => {
    // 13:00–16:30 booked: 16:30–17:00 (30 min) is too short; 10–12 stays.
    const items = monday([
      nineToTen(),
      noonToOne(),
      booking('2026-11-02T18:00:00Z', '2026-11-02T21:30:00Z'),
    ]);
    expect(only(items).payload).toMatchObject({ gapCount: 1, openMinutes: 120 });
    // 13:00–16:00 booked: 16:00–17:00 is exactly 60 minutes.
    const atMinimum = monday([
      nineToTen(),
      noonToOne(),
      booking('2026-11-02T18:00:00Z', '2026-11-02T21:00:00Z'),
    ]);
    expect(only(atMinimum).payload).toMatchObject({ gapCount: 2, openMinutes: 180 });
  });

  it("counts a booking's buffers as taken time and ignores cancelled bookings", () => {
    const withBuffer = booking('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z', {
      bufferAfterMinutes: 30,
    });
    expect(only(monday([withBuffer, noonToOne()])).payload).toMatchObject({ openMinutes: 330 });
    const cancelled = booking('2026-11-02T17:00:00Z', '2026-11-02T18:00:00Z', {
      status: 'cancelled',
    });
    expect(only(monday([nineToTen(), cancelled])).payload).toMatchObject({
      gapCount: 1,
      openMinutes: 420,
    });
  });

  it('starts from now: the past part of today is not a gap', () => {
    const item = only(monday([nineToTen(), noonToOne()], '2026-11-02T16:00:00Z'));
    expect(item.payload).toMatchObject({ gapCount: 2, openMinutes: 300 });
    expect(monday([], '2026-11-02T22:30:00Z')).toEqual([]);
  });

  it('treats time off as not open, and finds nothing for an inactive staff member', () => {
    const timeOff = [{ start: at('2026-11-02T18:00:00Z'), end: at('2026-11-02T22:00:00Z') }];
    const items = scheduleGaps.find(
      snapshot({
        now: at('2026-11-02T13:00:00Z'),
        staff: [staffMember(JESS, { hours: hours([1], 9, 17), timeOff })],
        bookings: [nineToTen(), noonToOne()],
      }),
    );
    expect(only(items).payload).toMatchObject({ gapCount: 1, openMinutes: 120 });
    const inactive = scheduleGaps.find(
      snapshot({
        now: at('2026-11-02T13:00:00Z'),
        staff: [staffMember(JESS, { active: false, hours: hours([1], 9, 17) })],
      }),
    );
    expect(inactive).toEqual([]);
  });

  it('looks 7 local days ahead, today included', () => {
    const items = scheduleGaps.find(
      snapshot({ now: at('2026-11-02T13:00:00Z'), staff: [staffMember(JESS)] }),
    );
    expect(items.map((item) => item.day)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('measures the spring-forward day in real time (New York, 2026-03-08)', () => {
    // Sundays 0:00–6:00; 2:00–3:00 does not exist that night: 5 real hours.
    const item = only(
      scheduleGaps.find(
        snapshot({
          now: at('2026-03-07T17:00:00Z'),
          staff: [staffMember(JESS, { hours: hours([7], 0, 6) })],
        }),
      ),
    );
    expect(item.day).toBe('2026-03-08');
    expect(item.payload).toMatchObject({
      openMinutes: 300,
      longestStartsAt: '2026-03-08T05:00:00.000Z',
      longestEndsAt: '2026-03-08T10:00:00.000Z',
    });
  });

  it('measures the fall-back day in real time (New York, 2026-11-01)', () => {
    // 1:00–2:00 happens twice: 7 real hours.
    const item = only(
      scheduleGaps.find(
        snapshot({
          now: at('2026-10-31T16:00:00Z'),
          staff: [staffMember(JESS, { hours: hours([7], 0, 6) })],
        }),
      ),
    );
    expect(item.day).toBe('2026-11-01');
    expect(item.payload).toMatchObject({
      openMinutes: 420,
      longestStartsAt: '2026-11-01T04:00:00.000Z',
      longestEndsAt: '2026-11-01T11:00:00.000Z',
    });
  });

  it('has no DST change in Phoenix on the same Sunday', () => {
    const item = only(
      scheduleGaps.find(
        snapshot({
          timeZone: PHOENIX,
          now: at('2026-03-07T17:00:00Z'),
          staff: [staffMember(JESS, { hours: hours([7], 0, 6) })],
        }),
      ),
    );
    expect(item.payload).toMatchObject({
      openMinutes: 360,
      longestStartsAt: '2026-03-08T07:00:00.000Z',
      longestEndsAt: '2026-03-08T13:00:00.000Z',
    });
  });

  it("reads today from the business's clock east of UTC (Kolkata, UTC+5:30)", () => {
    // 19:00 UTC Sunday is already 00:30 Monday in Kolkata: the 7 days run Monday to Sunday,
    // so the Sunday with hours is 2026-11-08, not the UTC Sunday 2026-11-01.
    const item = only(
      scheduleGaps.find(
        snapshot({
          timeZone: KOLKATA,
          now: at('2026-11-01T19:00:00Z'),
          staff: [staffMember(JESS, { hours: hours([7], 9, 17) })],
        }),
      ),
    );
    expect(item.day).toBe('2026-11-08');
    expect(item.payload).toMatchObject({
      openMinutes: 480,
      longestStartsAt: '2026-11-08T03:30:00.000Z',
      longestEndsAt: '2026-11-08T11:30:00.000Z',
    });
  });
});

describe('rebooking_due', () => {
  const now = at('2026-11-02T15:00:00Z');

  it("uses the service's interval: due 42 days after the last visit, with that stylist", () => {
    const visit = booking('2026-09-15T14:00:00Z', '2026-09-15T16:00:00Z', {
      serviceId: COLOR,
      staffMemberId: ANA,
      status: 'completed',
    });
    const item = only(rebookingDue.find(snapshot({ now, bookings: [visit] })));
    expect(item).toMatchObject({
      kind: 'rebooking_due',
      subjectKey: `client:${MARIA}`,
      day: '2026-10-27',
      audienceStaffId: ANA,
      subjects: { staffMemberId: ANA, clientId: MARIA, bookingId: visit.id, serviceId: COLOR },
      payload: {
        lastVisitAt: '2026-09-15T14:00:00.000Z',
        intervalDays: 42,
        basis: 'service',
        dueOn: '2026-10-27',
      },
    });
    // It goes away at twice the interval: local midnight starting 2026-12-08 (EST).
    expect(iso(item.expiresAt)).toBe('2026-12-08T05:00:00.000Z');
  });

  it('counts a past confirmed booking as a visit, but not a no-show or a cancellation', () => {
    const visit = booking('2026-09-15T14:00:00Z', '2026-09-15T16:00:00Z', { serviceId: COLOR });
    const missed = booking('2026-10-20T14:00:00Z', '2026-10-20T16:00:00Z', {
      serviceId: COLOR,
      status: 'no_show',
    });
    const cancelled = booking('2026-10-25T14:00:00Z', '2026-10-25T16:00:00Z', {
      serviceId: COLOR,
      status: 'cancelled',
    });
    const item = only(rebookingDue.find(snapshot({ now, bookings: [visit, missed, cancelled] })));
    expect(item.payload).toMatchObject({ lastVisitAt: '2026-09-15T14:00:00.000Z' });
  });

  it('finds nothing when the client is already booked again', () => {
    const visit = booking('2026-09-15T14:00:00Z', '2026-09-15T16:00:00Z', { serviceId: COLOR });
    const next = booking('2027-01-10T15:00:00Z', '2027-01-10T17:00:00Z', { serviceId: COLOR });
    expect(rebookingDue.find(snapshot({ now, bookings: [visit, next] }))).toEqual([]);
  });

  it('finds nothing once twice the interval has passed', () => {
    const visit = booking('2026-08-01T14:00:00Z', '2026-08-01T16:00:00Z', { serviceId: COLOR });
    expect(rebookingDue.find(snapshot({ now, bookings: [visit] }))).toEqual([]);
  });

  it("falls back to the client's median interval from 3 visits, and to nothing below", () => {
    const visits = ['2026-07-01', '2026-07-29', '2026-08-28', '2026-10-02'].map((date) =>
      booking(`${date}T14:00:00Z`, `${date}T15:00:00Z`, { serviceId: CUT }),
    );
    // Intervals 28, 30 and 35 days: the median is 30, so due 2026-11-01.
    const item = only(rebookingDue.find(snapshot({ now, bookings: visits })));
    expect(item.payload).toMatchObject({
      intervalDays: 30,
      basis: 'client_median',
      dueOn: '2026-11-01',
    });
    expect(iso(item.expiresAt)).toBe('2026-12-01T05:00:00.000Z');
    // Two visits are a one-off, not a habit.
    expect(rebookingDue.find(snapshot({ now, bookings: visits.slice(2) }))).toEqual([]);
  });

  it('takes the middle of an even count and keeps the interval at least a week', () => {
    const even = ['2026-06-01', '2026-06-29', '2026-07-29', '2026-09-02', '2026-10-12'].map(
      (date) => booking(`${date}T14:00:00Z`, `${date}T15:00:00Z`, { serviceId: CUT }),
    );
    // 28, 30, 35, 40: (30 + 35) / 2 rounds to 33; due 2026-11-14, not yet.
    expect(rebookingDue.find(snapshot({ now, bookings: even }))).toEqual([]);
    expect(
      only(rebookingDue.find(snapshot({ now: at('2026-11-14T15:00:00Z'), bookings: even })))
        .payload,
    ).toMatchObject({ intervalDays: 33, dueOn: '2026-11-14' });
    const twiceAWeek = ['2026-10-20', '2026-10-23', '2026-10-26', '2026-10-29'].map((date) =>
      booking(`${date}T14:00:00Z`, `${date}T15:00:00Z`, { serviceId: CUT }),
    );
    expect(
      only(rebookingDue.find(snapshot({ now: at('2026-11-05T15:00:00Z'), bookings: twiceAWeek })))
        .payload,
    ).toMatchObject({ intervalDays: 7, dueOn: '2026-11-05' });
  });

  it('adds calendar days across spring forward (New York, 2026-03-08)', () => {
    // 23:30 EST on Friday 2026-02-20 + 16 days is Sunday 2026-03-08; adding 16 × 24 hours would
    // land on 00:30 EDT Monday 2026-03-09.
    const visit = booking('2026-02-21T04:30:00Z', '2026-02-21T05:00:00Z', { serviceId: COLOR });
    const item = only(
      rebookingDue.find(
        snapshot({
          now: at('2026-03-08T12:00:00Z'),
          bookings: [visit],
          services: [{ id: COLOR, rebookAfterDays: 16 }],
        }),
      ),
    );
    expect(item.payload).toMatchObject({ dueOn: '2026-03-08', intervalDays: 16 });
  });

  it("counts days on the business's calendar east of UTC (Kolkata)", () => {
    // 20:00 UTC on 2026-10-01 is 01:30 on 2026-10-02 in Kolkata: due 2026-10-30, local.
    const visit = booking('2026-10-01T20:00:00Z', '2026-10-01T21:00:00Z', { serviceId: COLOR });
    const at2330 = snapshot({
      timeZone: KOLKATA,
      now: at('2026-10-29T18:00:00Z'),
      bookings: [visit],
      services: [{ id: COLOR, rebookAfterDays: 28 }],
    });
    expect(rebookingDue.find(at2330)).toEqual([]);
    const item = only(rebookingDue.find({ ...at2330, now: at('2026-10-29T19:00:00Z') }));
    expect(item.day).toBe('2026-10-30');
  });
});

describe('no_show_pattern', () => {
  const now = at('2026-11-02T15:00:00Z');
  const missed = (date: string) =>
    booking(`${date}T14:00:00Z`, `${date}T15:00:00Z`, { clientId: SAM, status: 'no_show' });
  const upcoming = (start: string) =>
    booking(start, new Date(at(start) + 3_600_000).toISOString(), { clientId: SAM });

  it('flags a client with 2 no-shows in 180 days who is booked in the next 7 days', () => {
    const next = upcoming('2026-11-06T15:00:00Z');
    const item = only(
      noShowPattern.find(
        snapshot({ now, bookings: [missed('2026-06-10'), missed('2026-09-01'), next] }),
      ),
    );
    expect(item).toMatchObject({
      kind: 'no_show_pattern',
      subjectKey: `client:${SAM}`,
      day: '2026-11-06',
      audienceStaffId: null,
      subjects: { staffMemberId: JESS, clientId: SAM, bookingId: next.id, serviceId: CUT },
      payload: { noShowCount: 2, windowDays: 180, bookingStartsAt: '2026-11-06T15:00:00.000Z' },
    });
    expect(item.expiresAt).toBe(next.start);
  });

  it('needs 2 no-shows inside the window', () => {
    const next = upcoming('2026-11-06T15:00:00Z');
    expect(noShowPattern.find(snapshot({ now, bookings: [missed('2026-09-01'), next] }))).toEqual(
      [],
    );
    // 2026-04-01 is more than 180 days before 2026-11-02.
    expect(
      noShowPattern.find(
        snapshot({ now, bookings: [missed('2026-04-01'), missed('2026-09-01'), next] }),
      ),
    ).toEqual([]);
  });

  it('needs a booking inside the horizon and picks the earliest', () => {
    const later = upcoming('2026-11-12T15:00:00Z');
    expect(
      noShowPattern.find(
        snapshot({ now, bookings: [missed('2026-06-10'), missed('2026-09-01'), later] }),
      ),
    ).toEqual([]);
    const sooner = upcoming('2026-11-04T15:00:00Z');
    const item = only(
      noShowPattern.find(
        snapshot({
          now,
          bookings: [
            missed('2026-06-10'),
            missed('2026-09-01'),
            upcoming('2026-11-06T15:00:00Z'),
            sooner,
          ],
        }),
      ),
    );
    expect(item.subjects.bookingId).toBe(sooner.id);
  });

  it("dates the item by the booking's local day (Kolkata)", () => {
    const next = upcoming('2026-11-04T20:00:00Z'); // 01:30 on 2026-11-05 in Kolkata
    const item = only(
      noShowPattern.find(
        snapshot({
          timeZone: KOLKATA,
          now: at('2026-11-02T00:00:00Z'),
          bookings: [missed('2026-06-10'), missed('2026-09-01'), next],
        }),
      ),
    );
    expect(item.day).toBe('2026-11-05');
  });
});

describe('staff_overload', () => {
  const now = at('2026-11-02T13:00:00Z'); // Monday 08:00 EST
  const fullDay = (date: string, endUtc = '22:00') =>
    booking(`${date}T14:00:00Z`, `${date}T${endUtc}:00Z`, { staffMemberId: ANA });
  const anaSnapshot = (bookings: ReturnType<typeof booking>[], extra = {}) =>
    snapshot({ now, staff: [staffMember(ANA, extra)], bookings });

  it('flags 3 or more days booked at least 90% in the next 7, for owners and managers', () => {
    const item = only(
      staffOverload.find(
        anaSnapshot([fullDay('2026-11-02'), fullDay('2026-11-03'), fullDay('2026-11-04')]),
      ),
    );
    expect(item).toMatchObject({
      kind: 'staff_overload',
      subjectKey: `staff:${ANA}`,
      day: '2026-11-02',
      audienceStaffId: null,
      subjects: { staffMemberId: ANA, clientId: null, bookingId: null, serviceId: null },
      payload: {
        busyDays: ['2026-11-02', '2026-11-03', '2026-11-04'],
        horizonDays: 7,
        peakPercent: 100,
      },
    });
    expect(iso(item.expiresAt)).toBe('2026-11-05T05:00:00.000Z');
  });

  it('needs 3 busy days, and a day at exactly 90% is busy while 87.5% is not', () => {
    const two = [fullDay('2026-11-02'), fullDay('2026-11-03')];
    expect(staffOverload.find(anaSnapshot(two))).toEqual([]);
    // 9:00–16:00 = 7 of 8 hours.
    expect(staffOverload.find(anaSnapshot([...two, fullDay('2026-11-04', '21:00')]))).toEqual([]);
    // 9:00–16:12 = 432 of 480 minutes.
    expect(
      only(staffOverload.find(anaSnapshot([...two, fullDay('2026-11-04', '21:12')]))).payload,
    ).toMatchObject({ busyDays: ['2026-11-02', '2026-11-03', '2026-11-04'] });
  });

  it('counts working time net of time off, and skips inactive staff', () => {
    const timeOff = [{ start: at('2026-11-04T18:00:00Z'), end: at('2026-11-04T22:00:00Z') }];
    const morning = booking('2026-11-04T14:00:00Z', '2026-11-04T18:00:00Z', { staffMemberId: ANA });
    const days = [fullDay('2026-11-02'), fullDay('2026-11-03'), morning];
    expect(only(staffOverload.find(anaSnapshot(days, { timeOff }))).payload).toMatchObject({
      busyDays: ['2026-11-02', '2026-11-03', '2026-11-04'],
    });
    expect(staffOverload.find(anaSnapshot(days, { timeOff, active: false }))).toEqual([]);
  });

  it('measures the fall-back day in real time (New York, 2026-11-01)', () => {
    // Every day 0:00–6:00. Sunday 2026-11-01 is 7 real hours, so 6 booked hours are 86%.
    const early = (start: string, end: string) => booking(start, end, { staffMemberId: ANA });
    const base = [
      early('2026-10-30T04:00:00Z', '2026-10-30T10:00:00Z'),
      early('2026-10-31T04:00:00Z', '2026-10-31T10:00:00Z'),
    ];
    const s = (bookings: ReturnType<typeof booking>[]) =>
      snapshot({
        now: at('2026-10-30T13:00:00Z'),
        staff: [staffMember(ANA, { hours: hours(EVERY_DAY, 0, 6) })],
        bookings,
      });
    expect(
      staffOverload.find(s([...base, early('2026-11-01T04:00:00Z', '2026-11-01T10:00:00Z')])),
    ).toEqual([]);
    const item = only(
      staffOverload.find(s([...base, early('2026-11-01T04:00:00Z', '2026-11-01T11:00:00Z')])),
    );
    expect(item.payload).toMatchObject({ busyDays: ['2026-10-30', '2026-10-31', '2026-11-01'] });
  });
});

describe('waitlist_match (S38a)', () => {
  const FREED = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700031' as BookingId;
  const match = (start: string, state: 'needs_ok' | 'offered' | 'claimed' = 'offered') => ({
    bookingId: FREED,
    staffMemberId: JESS,
    start: at(start),
    end: at(start) + 3_600_000,
    state,
    offered: state === 'needs_ok' ? 0 : 3,
  });

  it("shows a freed time to its staff member and the leads, dated by the slot's local day", () => {
    const item = only(
      waitlistMatch.find(
        snapshot({
          now: at('2026-11-02T15:00:00Z'),
          timeZone: KOLKATA,
          waitlistMatches: [match('2026-11-02T19:00:00Z')],
        }),
      ),
    );
    expect(item).toEqual({
      kind: 'waitlist_match',
      subjectKey: `booking:${FREED}`,
      // 00:30 on 3 November in Kolkata.
      day: '2026-11-03',
      audienceStaffId: JESS,
      subjects: { staffMemberId: JESS, clientId: null, bookingId: FREED, serviceId: null },
      payload: {
        startsAt: '2026-11-02T19:00:00.000Z',
        endsAt: '2026-11-02T20:00:00.000Z',
        state: 'offered',
        offered: 3,
      },
      expiresAt: at('2026-11-02T19:00:00Z'),
    });
  });

  it('keeps each state, and drops a time that has started', () => {
    const items = waitlistMatch.find(
      snapshot({
        now: at('2026-11-02T15:00:00Z'),
        waitlistMatches: [
          match('2026-11-02T16:00:00Z', 'needs_ok'),
          match('2026-11-02T17:00:00Z', 'claimed'),
          match('2026-11-02T15:00:00Z'),
        ],
      }),
    );
    expect(items.map((item) => item.payload)).toMatchObject([
      { state: 'needs_ok', offered: 0 },
      { state: 'claimed', offered: 3 },
    ]);
  });
});

describe('findInsights', () => {
  const busy = snapshot({
    now: at('2026-11-02T15:00:00Z'),
    staff: [staffMember(JESS, { hours: hours([1], 9, 17) })],
    bookings: [
      booking('2026-09-15T14:00:00Z', '2026-09-15T16:00:00Z', { serviceId: COLOR }),
      booking('2026-06-10T14:00:00Z', '2026-06-10T15:00:00Z', { clientId: SAM, status: 'no_show' }),
      booking('2026-09-01T14:00:00Z', '2026-09-01T15:00:00Z', { clientId: SAM, status: 'no_show' }),
      booking('2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z', { clientId: SAM }),
    ],
  });

  it('runs the enabled kinds only, in a stable order with unique keys', () => {
    const all = findInsights(busy, [
      'schedule_gaps',
      'rebooking_due',
      'no_show_pattern',
      'staff_overload',
    ]);
    expect(all.map((item) => item.kind)).toEqual([
      'schedule_gaps',
      'rebooking_due',
      'no_show_pattern',
    ]);
    expect(new Set(all.map(dedupeKey)).size).toBe(all.length);
    expect(findInsights(busy, ['rebooking_due']).map((item) => item.kind)).toEqual([
      'rebooking_due',
    ]);
    expect(findInsights(busy, [])).toEqual([]);
  });

  it('is deterministic: the same snapshot gives the same items', () => {
    const kinds = ['schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload'] as const;
    expect(findInsights(busy, kinds)).toEqual(findInsights(busy, kinds));
  });
});
