import { describe, expect, it } from 'vitest';
import {
  BookingRulesSchema,
  daysBetween,
  LocalDateSchema,
  PLATFORM_RULE_DEFAULTS,
  RULE_LIMITS,
  RuleSchema,
} from './rules.js';

const STAFF_A = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198';
const STAFF_B = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F70819B';

describe('RuleSchema', () => {
  it('applies the version and the business scope by default', () => {
    expect(RuleSchema.parse({ type: 'minimum_notice', params: { minutes: 60 } })).toEqual({
      type: 'minimum_notice',
      version: 1,
      staffMemberId: null,
      params: { minutes: 60 },
    });
  });

  it('lowercases a staff member id', () => {
    expect(
      RuleSchema.parse({ type: 'maximum_advance', staffMemberId: STAFF_B, params: { days: 30 } }),
    ).toMatchObject({ staffMemberId: STAFF_B.toLowerCase() });
  });

  it.each(RULE_LIMITS.slotIntervalMinutes)('accepts a %i-minute slot interval', (minutes) => {
    expect(RuleSchema.safeParse({ type: 'slot_interval', params: { minutes } }).success).toBe(true);
  });

  it.each([0, 7, 45, 90])('rejects a %i-minute slot interval (must divide an hour)', (minutes) => {
    expect(RuleSchema.safeParse({ type: 'slot_interval', params: { minutes } }).success).toBe(
      false,
    );
  });

  it.each([
    { type: 'minimum_notice', params: { minutes: -1 } },
    { type: 'minimum_notice', params: { minutes: RULE_LIMITS.maxMinimumNoticeMinutes + 1 } },
    { type: 'minimum_notice', params: { minutes: 1.5 } },
    { type: 'maximum_advance', params: { days: 0 } },
    { type: 'maximum_advance', params: { days: RULE_LIMITS.maxAdvanceDays + 1 } },
    { type: 'max_bookings_per_day', params: { count: 0 } },
    { type: 'max_bookings_per_day', params: { count: RULE_LIMITS.maxBookingsPerDay + 1 } },
  ])('rejects out-of-range params: $type $params', (rule) => {
    expect(RuleSchema.safeParse(rule).success).toBe(false);
  });

  it('accepts the limits themselves', () => {
    for (const rule of [
      { type: 'minimum_notice', params: { minutes: 0 } },
      { type: 'minimum_notice', params: { minutes: RULE_LIMITS.maxMinimumNoticeMinutes } },
      { type: 'maximum_advance', params: { days: 1 } },
      { type: 'maximum_advance', params: { days: RULE_LIMITS.maxAdvanceDays } },
      { type: 'max_bookings_per_day', params: { count: 1 } },
      { type: 'max_bookings_per_day', params: { count: RULE_LIMITS.maxBookingsPerDay } },
    ]) {
      expect(RuleSchema.safeParse(rule).success).toBe(true);
    }
  });

  it('rejects unknown types, versions, extra fields and params of another type', () => {
    for (const rule of [
      { type: 'learned', params: {} },
      { type: 'minimum_notice', version: 2, params: { minutes: 60 } },
      { type: 'minimum_notice', params: { minutes: 60 }, note: 'Ana said so' },
      { type: 'minimum_notice', params: { minutes: 60, days: 1 } },
      { type: 'minimum_notice', params: { days: 1 } },
      { type: 'minimum_notice', staffMemberId: 'jess', params: { minutes: 60 } },
    ]) {
      expect(RuleSchema.safeParse(rule).success).toBe(false);
    }
  });

  describe('blackout_window', () => {
    const blackout = (startDate: string, endDate: string) => ({
      type: 'blackout_window',
      params: { startDate, endDate },
    });

    it('accepts a single day and a range', () => {
      expect(RuleSchema.safeParse(blackout('2026-12-25', '2026-12-25')).success).toBe(true);
      expect(RuleSchema.safeParse(blackout('2026-12-24', '2027-01-01')).success).toBe(true);
    });

    it('rejects an end before the start', () => {
      expect(RuleSchema.safeParse(blackout('2026-12-26', '2026-12-25')).success).toBe(false);
    });

    it('covers at most 366 days', () => {
      expect(RuleSchema.safeParse(blackout('2028-01-01', '2028-12-31')).success).toBe(true);
      expect(RuleSchema.safeParse(blackout('2027-01-01', '2028-01-01')).success).toBe(true);
      expect(RuleSchema.safeParse(blackout('2027-01-01', '2028-01-02')).success).toBe(false);
    });

    it('rejects dates that do not exist or are not plain dates', () => {
      for (const date of ['2026-02-29', '2026-13-01', '2026-04-31', '2026-12-25T00:00', '12/25']) {
        expect(RuleSchema.safeParse(blackout(date, date)).success).toBe(false);
      }
      expect(RuleSchema.safeParse(blackout('2028-02-29', '2028-02-29')).success).toBe(true);
    });
  });
});

describe('BookingRulesSchema', () => {
  it('sorts business rules first, then by staff member, type and first day', () => {
    const { rules } = BookingRulesSchema.parse({
      rules: [
        { type: 'blackout_window', params: { startDate: '2026-12-31', endDate: '2027-01-01' } },
        { type: 'minimum_notice', staffMemberId: STAFF_A, params: { minutes: 0 } },
        { type: 'blackout_window', params: { startDate: '2026-12-25', endDate: '2026-12-25' } },
        { type: 'slot_interval', params: { minutes: 30 } },
      ],
    });
    expect(rules.map((r) => [r.staffMemberId, r.type])).toEqual([
      [null, 'slot_interval'],
      [null, 'blackout_window'],
      [null, 'blackout_window'],
      [STAFF_A, 'minimum_notice'],
    ]);
    expect(rules[1]).toMatchObject({ params: { startDate: '2026-12-25' } });
  });

  it('allows one rule of a type for the business and one per staff member', () => {
    const result = BookingRulesSchema.safeParse({
      rules: [
        { type: 'minimum_notice', params: { minutes: 60 } },
        { type: 'minimum_notice', staffMemberId: STAFF_A, params: { minutes: 0 } },
        { type: 'minimum_notice', staffMemberId: STAFF_B, params: { minutes: 0 } },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects the same single-valued type twice in one scope', () => {
    for (const staffMemberId of [null, STAFF_A]) {
      const result = BookingRulesSchema.safeParse({
        rules: [
          { type: 'max_bookings_per_day', staffMemberId, params: { count: 5 } },
          { type: 'max_bookings_per_day', staffMemberId, params: { count: 6 } },
        ],
      });
      expect(result.success).toBe(false);
    }
  });

  it('allows several blackout windows but not the same one twice', () => {
    const christmas = { startDate: '2026-12-25', endDate: '2026-12-25' };
    const newYear = { startDate: '2027-01-01', endDate: '2027-01-01' };
    expect(
      BookingRulesSchema.safeParse({
        rules: [
          { type: 'blackout_window', params: christmas },
          { type: 'blackout_window', params: newYear },
          { type: 'blackout_window', staffMemberId: STAFF_A, params: christmas },
        ],
      }).success,
    ).toBe(true);
    expect(
      BookingRulesSchema.safeParse({
        rules: [
          { type: 'blackout_window', params: christmas },
          { type: 'blackout_window', params: christmas },
        ],
      }).success,
    ).toBe(false);
  });

  it('accepts an empty set and caps its size', () => {
    expect(BookingRulesSchema.parse({ rules: [] })).toEqual({ rules: [] });
    const blackouts = (count: number) =>
      Array.from({ length: count }, (_, day) => {
        const date = new Date(Date.UTC(2027, 0, 1 + day)).toISOString().slice(0, 10);
        return { type: 'blackout_window', params: { startDate: date, endDate: date } };
      });
    expect(BookingRulesSchema.safeParse({ rules: blackouts(RULE_LIMITS.maxRules) }).success).toBe(
      true,
    );
    expect(
      BookingRulesSchema.safeParse({ rules: blackouts(RULE_LIMITS.maxRules + 1) }).success,
    ).toBe(false);
  });
});

describe('dates', () => {
  it('counts days between local dates across DST and leap days', () => {
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-12-25', '2026-12-24')).toBe(-1);
  });

  it('validates plain dates', () => {
    expect(LocalDateSchema.safeParse('2026-11-01').success).toBe(true);
    expect(LocalDateSchema.safeParse('2026-11-1').success).toBe(false);
  });
});

describe('PLATFORM_RULE_DEFAULTS', () => {
  it('holds the defaults agreed at S11', () => {
    expect(PLATFORM_RULE_DEFAULTS).toEqual({
      slotIntervalMinutes: 15,
      minimumNoticeMinutes: 120,
      maximumAdvanceDays: 90,
      maxBookingsPerDay: null,
    });
  });
});
