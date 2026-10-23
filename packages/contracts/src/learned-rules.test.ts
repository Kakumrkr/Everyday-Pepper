import { describe, expect, it } from 'vitest';
import { LearnedRuleSchema, learnedRulePermission } from './learned-rules.js';
import { OutboxEpisodeSchema, OutboxMessageTypeSchema } from './outbox.js';

const JESS = '0199f4b2-7c1e-7a00-8000-000000000001';

describe('LearnedRuleSchema', () => {
  it('maps a preference onto a rule type or a weekday hours limit', () => {
    expect(
      LearnedRuleSchema.parse({ kind: 'minimum_notice', staffMemberId: null, minutes: 1440 }),
    ).toEqual({ kind: 'minimum_notice', staffMemberId: null, minutes: 1440 });
    expect(
      LearnedRuleSchema.parse({
        kind: 'hours_limit',
        staffMemberId: null,
        weekday: 1,
        notBefore: '10:00',
        notAfter: null,
        closed: false,
      }).kind,
    ).toBe('hours_limit');
    expect(
      LearnedRuleSchema.safeParse({
        kind: 'hours_limit',
        staffMemberId: JESS,
        weekday: 6,
        notBefore: null,
        notAfter: null,
        closed: true,
      }).success,
    ).toBe(true);
  });

  it('refuses free-form rules, unknown fields and contradictions', () => {
    const bad = [
      { kind: 'no_mondays', staffMemberId: null },
      { kind: 'slot_interval', staffMemberId: null, minutes: 15 },
      { kind: 'minimum_notice', staffMemberId: null, minutes: 60, note: 'x' },
      { kind: 'max_bookings_per_day', staffMemberId: null, count: 0 },
      {
        kind: 'blackout_window',
        staffMemberId: null,
        startDate: '2026-12-26',
        endDate: '2026-12-24',
      },
      {
        kind: 'hours_limit',
        staffMemberId: null,
        weekday: 1,
        notBefore: null,
        notAfter: null,
        closed: false,
      },
      {
        kind: 'hours_limit',
        staffMemberId: null,
        weekday: 1,
        notBefore: '10:00',
        notAfter: null,
        closed: true,
      },
      {
        kind: 'hours_limit',
        staffMemberId: null,
        weekday: 8,
        notBefore: '10:00',
        notAfter: null,
        closed: false,
      },
      {
        kind: 'hours_limit',
        staffMemberId: null,
        weekday: 1,
        notBefore: '15:00',
        notAfter: '10:00',
        closed: false,
      },
    ];
    for (const rule of bad)
      expect(LearnedRuleSchema.safeParse(rule).success, JSON.stringify(rule)).toBe(false);
  });

  it('needs hours.manage for hours and rules.manage for the rest', () => {
    expect(learnedRulePermission({ kind: 'hours_limit' })).toBe('hours.manage');
    expect(learnedRulePermission({ kind: 'blackout_window' })).toBe('rules.manage');
  });
});

describe('OutboxEpisodeSchema', () => {
  it('is ids only', () => {
    expect(OutboxMessageTypeSchema.options).toContain('episode');
    const ids = { conversationId: JESS, userId: JESS, turnId: JESS };
    expect(OutboxEpisodeSchema.parse(ids)).toEqual(ids);
    expect(OutboxEpisodeSchema.safeParse({ ...ids, summary: 'Maria' }).success).toBe(false);
  });
});
