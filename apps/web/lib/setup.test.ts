import type { Booking, Rule, Service } from '@pepper/contracts';
import { PLATFORM_RULE_DEFAULTS } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  businessRulesOf,
  centsFromText,
  choicesWith,
  closedDaysLabel,
  clockLabel,
  daysLabel,
  defaultsLabel,
  durationLabel,
  hoursFromWeek,
  hoursSummary,
  timeChoices,
  localDateIn,
  money,
  noticeLabel,
  priceLabel,
  servicesByCategory,
  splitVisits,
  textFromCents,
  timeOffLabel,
  timeOffSpan,
  visitRanges,
  weekOf,
  withBusinessRules,
} from './setup';

const NY = 'America/New_York';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198';

describe('money', () => {
  it.each([
    ['65', 6500],
    ['$65', 6500],
    [' 65.5 ', 6550],
    ['65.05', 6505],
    ['1,200', 120000],
    ['0', 0],
  ])('reads %j as %d cents', (text, cents) => {
    expect(centsFromText(text)).toBe(cents);
  });

  it('reads an empty field as no price, and refuses what is not an amount', () => {
    expect(centsFromText('  ')).toBeNull();
    for (const text of ['abc', '65.555', '-5', '6 5', '$']) {
      expect(centsFromText(text)).toBe('invalid');
    }
  });

  it('writes cents back for the field and for people', () => {
    expect(textFromCents(null)).toBe('');
    expect(textFromCents(6500)).toBe('65');
    expect(textFromCents(6505)).toBe('65.05');
    expect(money(6500)).toBe('$65');
    expect(money(6550)).toBe('$65.50');
    expect(money(120000)).toBe('$1,200');
  });

  it('labels a price as "from" or a range, or none', () => {
    expect(priceLabel({ priceFromCents: null, priceToCents: null })).toBeNull();
    expect(priceLabel({ priceFromCents: 6500, priceToCents: null })).toBe('from $65');
    expect(priceLabel({ priceFromCents: 6500, priceToCents: 8000 })).toBe('$65–$80');
  });
});

describe('durationLabel', () => {
  it.each([
    [45, '45 min'],
    [60, '1 h'],
    [90, '1 h 30 min'],
    [720, '12 h'],
  ])('%d minutes: %s', (minutes, label) => {
    expect(durationLabel(minutes)).toBe(label);
  });
});

describe('servicesByCategory', () => {
  const service = (name: string, category: string | null) => ({ name, category }) as Service;

  it('groups by category, case-insensitively, by name, uncategorized last', () => {
    const groups = servicesByCategory([
      service('Cut', 'Hair'),
      service('Gift card', null),
      service('Gel', 'Nails'),
      service('Blow-dry', 'hair'),
    ]);
    expect(groups.map((g) => [g.category, g.services.map((s) => s.name)])).toEqual([
      ['Hair', ['Cut', 'Blow-dry']],
      ['Nails', ['Gel']],
      [null, ['Gift card']],
    ]);
    expect(servicesByCategory([])).toEqual([]);
    expect(servicesByCategory([service('A', null), service('B', 'X')])[0]?.category).toBe('X');
  });
});

describe('weekly hours', () => {
  const hours = {
    intervals: [
      { weekday: 1, start: '09:00', end: '17:00' },
      { weekday: 2, start: '09:00', end: '17:00' },
      { weekday: 3, start: '09:00', end: '12:00' },
      { weekday: 3, start: '13:00', end: '17:00' },
      { weekday: 6, start: '10:00', end: '24:00' },
    ],
  };

  it('lays the week out Monday first and back', () => {
    const week = weekOf(hours);
    expect(week).toHaveLength(7);
    expect(week[2]).toEqual({
      weekday: 3,
      intervals: [
        { start: '09:00', end: '12:00' },
        { start: '13:00', end: '17:00' },
      ],
    });
    expect(week[6]).toEqual({ weekday: 7, intervals: [] });
    expect(hoursFromWeek(week)).toEqual(hours);
  });

  it('summarises consecutive days with the same hours, leaving out days off', () => {
    expect(hoursSummary(hours)).toEqual([
      'Mon–Tue 9:00 AM–5:00 PM',
      'Wed 9:00 AM–12:00 PM, 1:00 PM–5:00 PM',
      'Sat 10:00 AM–midnight',
    ]);
    expect(hoursSummary({ intervals: [] })).toEqual([]);
  });

  it('offers times every 15 minutes to midnight, plus stored ones off the grid', () => {
    const times = timeChoices();
    expect(times).toHaveLength(97);
    expect([times[0], times[1], times[96]]).toEqual(['00:00', '00:15', '24:00']);
    const extra = timeChoices(['09:05', '09:00']);
    expect(extra).toHaveLength(98);
    expect(extra.slice(36, 39)).toEqual(['09:00', '09:05', '09:15']);
  });

  it.each([
    ['00:00', '12:00 AM'],
    ['09:05', '9:05 AM'],
    ['12:30', '12:30 PM'],
    ['23:59', '11:59 PM'],
    ['24:00', 'midnight'],
  ])('clock %s: %s', (time, label) => {
    expect(clockLabel(time)).toBe(label);
  });
});

describe('time off', () => {
  it('turns whole local days into an exact span, across a clock change', () => {
    // 1 November 2026: New York goes back to EST.
    expect(timeOffSpan(NY, { firstDay: '2026-10-31', lastDay: '2026-11-01' })).toEqual({
      startsAt: '2026-10-31T04:00:00.000Z',
      endsAt: '2026-11-02T05:00:00.000Z',
    });
  });

  it('turns part of one day into an exact span', () => {
    expect(
      timeOffSpan(NY, {
        firstDay: '2026-11-03',
        lastDay: '2026-11-09',
        from: '09:00',
        to: '13:00',
      }),
    ).toEqual({ startsAt: '2026-11-03T14:00:00.000Z', endsAt: '2026-11-03T18:00:00.000Z' });
  });

  it.each([
    ['no first day', { firstDay: '', lastDay: '2026-11-03' }],
    ['no last day', { firstDay: '2026-11-03', lastDay: '' }],
    ['a last day before the first', { firstDay: '2026-11-03', lastDay: '2026-11-02' }],
    ['a missing time', { firstDay: '2026-11-03', lastDay: '', from: '09:00' }],
    [
      'an end before the start',
      { firstDay: '2026-11-03', lastDay: '', from: '13:00', to: '09:00' },
    ],
    ['a malformed time', { firstDay: '2026-11-03', lastDay: '', from: '9', to: '13:00' }],
  ])('refuses %s', (_label, entry) => {
    expect(timeOffSpan(NY, entry)).toBeNull();
  });

  it('labels whole days and parts of days on the business clock', () => {
    const days = (firstDay: string, lastDay: string) =>
      timeOffLabel(NY, timeOffSpan(NY, { firstDay, lastDay }) ?? { startsAt: '', endsAt: '' });
    expect(days('2026-11-03', '2026-11-03')).toBe('Tue, Nov 3');
    expect(days('2026-10-31', '2026-11-01')).toBe('Sat, Oct 31 – Sun, Nov 1');
    expect(
      timeOffLabel(NY, {
        startsAt: '2026-11-03T14:00:00.000Z',
        endsAt: '2026-11-03T18:30:00.000Z',
      }),
    ).toBe('Tue, Nov 3, 9:00 AM – 1:30 PM');
    expect(
      timeOffLabel(NY, {
        startsAt: '2026-11-03T14:00:00.000Z',
        endsAt: '2026-11-04T18:00:00.000Z',
      }),
    ).toBe('Tue, Nov 3, 9:00 AM – Wed, Nov 4, 1:00 PM');
  });
});

describe('booking rules', () => {
  const rules: Rule[] = [
    { type: 'minimum_notice', version: 1, staffMemberId: null, params: { minutes: 60 } },
    {
      type: 'blackout_window',
      version: 1,
      staffMemberId: null,
      params: { startDate: '2026-12-24', endDate: '2026-12-26' },
    },
    { type: 'slot_interval', version: 1, staffMemberId: STAFF, params: { minutes: 30 } },
  ] as Rule[];

  it('reads the business-wide rules, leaving staff members’ own out', () => {
    expect(businessRulesOf(rules)).toEqual({
      slotIntervalMinutes: null,
      minimumNoticeMinutes: 60,
      maximumAdvanceDays: null,
      maxBookingsPerDay: null,
      blackouts: [{ startDate: '2026-12-24', endDate: '2026-12-26' }],
    });
  });

  it('writes the edited business rules and keeps staff members’ own as they were', () => {
    expect(
      withBusinessRules(rules, {
        slotIntervalMinutes: 15,
        minimumNoticeMinutes: null,
        maximumAdvanceDays: 30,
        maxBookingsPerDay: 8,
        blackouts: [{ startDate: '2026-12-25', endDate: '2026-12-25' }],
      }),
    ).toEqual([
      { type: 'slot_interval', params: { minutes: 15 } },
      { type: 'maximum_advance', params: { days: 30 } },
      { type: 'max_bookings_per_day', params: { count: 8 } },
      { type: 'blackout_window', params: { startDate: '2026-12-25', endDate: '2026-12-25' } },
      rules[2],
    ]);
    const cleared = withBusinessRules(rules, { ...businessRulesOf([]), minimumNoticeMinutes: 0 });
    expect(cleared).toEqual([{ type: 'minimum_notice', params: { minutes: 0 } }, rules[2]]);
  });

  it.each([
    [0, 'no notice'],
    [1, '1 minute'],
    [30, '30 minutes'],
    [60, '1 hour'],
    [120, '2 hours'],
    [1440, '1 day'],
    [2880, '2 days'],
    [10080, '1 week'],
  ])('notice of %d minutes: %s', (minutes, label) => {
    expect(noticeLabel(minutes)).toBe(label);
  });

  it('offers the choices, plus a stored value that is not one of them, in order', () => {
    expect(choicesWith([30, 60, 120], null)).toEqual([30, 60, 120]);
    expect(choicesWith([30, 60, 120], 60)).toEqual([30, 60, 120]);
    expect(choicesWith([30, 60, 120], 90)).toEqual([30, 60, 90, 120]);
  });

  it('labels closed days with their year', () => {
    expect(closedDaysLabel({ startDate: '2026-12-25', endDate: '2026-12-25' })).toBe(
      'Fri, Dec 25, 2026',
    );
    expect(closedDaysLabel({ startDate: '2026-12-31', endDate: '2027-01-01' })).toBe(
      'Thu, Dec 31, 2026 – Fri, Jan 1, 2027',
    );
  });

  it('describes the defaults in force', () => {
    expect(daysLabel(1)).toBe('1 day');
    expect(defaultsLabel(PLATFORM_RULE_DEFAULTS)).toBe(
      'every 15 minutes, 2 hours ahead, up to 90 days out, no daily limit',
    );
    expect(defaultsLabel({ ...PLATFORM_RULE_DEFAULTS, maxBookingsPerDay: 6 })).toMatch(
      /at most 6 a day$/,
    );
  });
});

describe("a client's visits", () => {
  const NOW = Date.parse('2026-11-02T12:00:00.000Z');
  const booking = (id: string, startsAt: string, endsAt: string, status = 'confirmed') =>
    ({ id, startsAt, endsAt, status }) as Booking;

  it('asks 62 days back and ahead of now', () => {
    expect(visitRanges(NOW)).toEqual({
      past: { from: '2026-09-01T12:00:00.000Z', to: '2026-11-02T12:00:00.000Z' },
      upcoming: { from: '2026-11-02T12:00:00.000Z', to: '2027-01-03T12:00:00.000Z' },
    });
  });

  it('splits at now: upcoming soonest first without cancelled ones, past latest first', () => {
    const now = booking('now', '2026-11-02T11:30:00.000Z', '2026-11-02T12:30:00.000Z');
    const later = booking('later', '2026-11-09T15:00:00.000Z', '2026-11-09T16:00:00.000Z');
    const cancelled = booking(
      'x',
      '2026-11-05T15:00:00.000Z',
      '2026-11-05T16:00:00.000Z',
      'cancelled',
    );
    const old = booking('old', '2026-10-01T15:00:00.000Z', '2026-10-01T16:00:00.000Z', 'completed');
    const older = booking(
      'older',
      '2026-09-20T15:00:00.000Z',
      '2026-09-20T16:00:00.000Z',
      'no_show',
    );
    // `now` comes back from both ranges: it counts once.
    const { upcoming, past } = splitVisits([older, now, old, later, cancelled, now], NOW);
    expect(upcoming.map((b) => b.id)).toEqual(['now', 'later']);
    expect(past.map((b) => b.id)).toEqual(['old', 'older']);
  });
});

describe('localDateIn', () => {
  it("is the business's date, not the server's", () => {
    // 02:00 UTC on 3 November is still 2 November in New York.
    const now = Date.parse('2026-11-03T02:00:00.000Z');
    expect(localDateIn(NY, now)).toBe('2026-11-02');
    expect(localDateIn(NY, now, 7)).toBe('2026-11-09');
  });
});
