import { describe, expect, it } from 'vitest';
import { describeLearnedRule, LearnedRuleInverseSchema } from './learned-rules.js';

// The words of a learned rule (S31): the card, *Why?* and the remembered fact all say it so.

const scope = { staffMemberId: null };

describe('describeLearnedRule', () => {
  it('says every kind in one plain sentence', () => {
    expect(describeLearnedRule({ kind: 'minimum_notice', ...scope, minutes: 0 })).toBe(
      'Bookings need no notice',
    );
    expect(describeLearnedRule({ kind: 'minimum_notice', ...scope, minutes: 60 })).toBe(
      "Bookings need at least 1 hour's notice",
    );
    expect(describeLearnedRule({ kind: 'minimum_notice', ...scope, minutes: 2880 })).toBe(
      "Bookings need at least 2 days' notice",
    );
    expect(describeLearnedRule({ kind: 'minimum_notice', ...scope, minutes: 90 })).toBe(
      "Bookings need at least 90 minutes' notice",
    );
    expect(describeLearnedRule({ kind: 'maximum_advance', ...scope, days: 60 })).toBe(
      'Bookings at most 60 days ahead',
    );
    expect(describeLearnedRule({ kind: 'max_bookings_per_day', ...scope, count: 1 })).toBe(
      'At most 1 booking a day',
    );
    expect(
      describeLearnedRule({
        kind: 'blackout_window',
        ...scope,
        startDate: '2026-12-24',
        endDate: '2026-12-26',
      }),
    ).toBe('No bookings from 2026-12-24 to 2026-12-26');
    expect(
      describeLearnedRule({
        kind: 'blackout_window',
        ...scope,
        startDate: '2026-12-25',
        endDate: '2026-12-25',
      }),
    ).toBe('No bookings on 2026-12-25');
    const hours = { kind: 'hours_limit' as const, ...scope, weekday: 1 };
    expect(describeLearnedRule({ ...hours, notBefore: null, notAfter: null, closed: true })).toBe(
      'No bookings on Mondays',
    );
    expect(
      describeLearnedRule({ ...hours, notBefore: '10:00', notAfter: null, closed: false }),
    ).toBe('No bookings before 10:00 on Mondays');
    expect(
      describeLearnedRule({
        ...hours,
        weekday: 7,
        notBefore: null,
        notAfter: '15:00',
        closed: false,
      }),
    ).toBe('No bookings after 15:00 on Sundays');
    expect(
      describeLearnedRule({ ...hours, notBefore: '10:00', notAfter: '16:00', closed: false }),
    ).toBe('Mondays only 10:00–16:00');
  });
});

describe('LearnedRuleInverseSchema', () => {
  it('is the rule set or the weeks, nothing else', () => {
    expect(
      LearnedRuleInverseSchema.safeParse({ kind: 'rules', before: [], after: [] }).success,
    ).toBe(true);
    expect(LearnedRuleInverseSchema.safeParse({ kind: 'hours', weeks: [] }).success).toBe(true);
    expect(LearnedRuleInverseSchema.safeParse({ kind: 'rules', before: [] }).success).toBe(false);
  });
});
