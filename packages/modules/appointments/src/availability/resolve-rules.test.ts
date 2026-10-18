import { BookingRulesSchema, type BookingRulesInput, type StaffMemberId } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { resolveRules } from './resolve-rules.js';

const JESS = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198' as StaffMemberId;
const MARCO = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199' as StaffMemberId;
const rules = (input: BookingRulesInput['rules']) =>
  BookingRulesSchema.parse({ rules: input }).rules;

describe('resolveRules', () => {
  it('uses the platform defaults when nothing is set', () => {
    expect(resolveRules([], JESS)).toEqual({
      slotIntervalMinutes: 15,
      minimumNoticeMinutes: 120,
      maximumAdvanceDays: 90,
      maxBookingsPerDay: null,
      blackouts: [],
    });
  });

  it("uses the template's defaults over the platform's", () => {
    expect(
      resolveRules([], JESS, { minimumNoticeMinutes: 1440, maxBookingsPerDay: 6 }),
    ).toMatchObject({
      slotIntervalMinutes: 15,
      minimumNoticeMinutes: 1440,
      maxBookingsPerDay: 6,
    });
  });

  it("uses the business's rules over the template, and a staff member's over the business's", () => {
    const set = rules([
      { type: 'minimum_notice', params: { minutes: 60 } },
      { type: 'minimum_notice', staffMemberId: JESS, params: { minutes: 0 } },
      { type: 'slot_interval', params: { minutes: 30 } },
      { type: 'max_bookings_per_day', staffMemberId: MARCO, params: { count: 4 } },
      { type: 'maximum_advance', staffMemberId: JESS, params: { days: 14 } },
    ]);
    const template = { minimumNoticeMinutes: 1440, slotIntervalMinutes: 20 as const };
    expect(resolveRules(set, JESS, template)).toEqual({
      slotIntervalMinutes: 30,
      minimumNoticeMinutes: 0,
      maximumAdvanceDays: 14,
      maxBookingsPerDay: null,
      blackouts: [],
    });
    expect(resolveRules(set, MARCO, template)).toEqual({
      slotIntervalMinutes: 30,
      minimumNoticeMinutes: 60,
      maximumAdvanceDays: 90,
      maxBookingsPerDay: 4,
      blackouts: [],
    });
  });

  it("adds the business's blackout windows to the staff member's own", () => {
    const set = rules([
      { type: 'blackout_window', params: { startDate: '2026-12-25', endDate: '2026-12-26' } },
      {
        type: 'blackout_window',
        staffMemberId: JESS,
        params: { startDate: '2026-11-20', endDate: '2026-11-27' },
      },
      {
        type: 'blackout_window',
        staffMemberId: MARCO,
        params: { startDate: '2026-11-02', endDate: '2026-11-02' },
      },
    ]);
    expect(resolveRules(set, JESS).blackouts).toEqual([
      { startDate: '2026-12-25', endDate: '2026-12-26' },
      { startDate: '2026-11-20', endDate: '2026-11-27' },
    ]);
    expect(resolveRules(set, MARCO).blackouts).toHaveLength(2);
  });

  it('does not depend on the order of the rules', () => {
    const set = rules([
      { type: 'minimum_notice', staffMemberId: JESS, params: { minutes: 0 } },
      { type: 'minimum_notice', params: { minutes: 60 } },
    ]);
    expect(resolveRules([...set].reverse(), JESS)).toEqual(resolveRules(set, JESS));
  });
});
