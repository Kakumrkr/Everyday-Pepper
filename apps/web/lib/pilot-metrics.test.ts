import { describe, expect, it } from 'vitest';
import { OPS_PATHS } from './ops';
import {
  channelRows,
  emailShareWords,
  firstReplyRows,
  metricTrend,
  metricValueWords,
  metricsDays,
  minutesWords,
  PILOT_METRIC_GROUPS,
  PILOT_METRIC_LABEL,
  sampleWords,
  targetWords,
} from './pilot-metrics';

describe('the pilot metrics page’s words (S59.4)', () => {
  it('takes 7 or 30 days from the address', () => {
    expect(metricsDays(undefined)).toBe(7);
    expect(metricsDays('30')).toBe(30);
    expect(metricsDays(['30', '7'])).toBe(7);
    expect(metricsDays('365')).toBe(7);
    expect(OPS_PATHS.metrics()).toBe('/ops/metrics');
    expect(OPS_PATHS.metrics(30)).toBe('/ops/metrics?days=30');
  });

  it('says minutes in words', () => {
    expect(minutesWords(0.5)).toBe('30 s');
    expect(minutesWords(9.04)).toBe('9 min');
    expect(minutesWords(60)).toBe('1 h');
    expect(minutesWords(95.6)).toBe('1 h 36 min');
    expect(minutesWords(26 * 60)).toBe('1 d 2 h');
    expect(minutesWords(48 * 60)).toBe('2 d');
    expect(minutesWords(2850)).toBe('2 d');
    expect(minutesWords(0.999)).toBe('1 min');
  });

  it('says each number in its unit, and none as a dash', () => {
    expect(metricValueWords({ key: 'onboarding_completion', value: 80 })).toBe('80%');
    expect(metricValueWords({ key: 'fill_rate', value: 33.3 })).toBe('33.3%');
    expect(metricValueWords({ key: 'time_to_bookable', value: 9 })).toBe('9 min');
    expect(metricValueWords({ key: 'support_requests', value: 0.7 })).toBe('0.7 a week');
    expect(metricValueWords({ key: 'waitlist_conversion', value: null })).toBe('–');
  });

  it('says each target as the scorecard does', () => {
    expect(targetWords('onboarding_completion')).toBe('Target: at least 80%');
    expect(targetWords('code_step_drop_off')).toBe('Target: at most 15%');
    expect(targetWords('time_to_first_booking')).toBe('Target: median at most 15 min');
    expect(targetWords('support_requests')).toBe('Target: at most 1 a business a week');
    expect(targetWords('first_reply_time')).toBe('Target: median at most 4 h, all the same day');
    expect(targetWords('fill_rate')).toBe('Target set after week 2');
    expect(targetWords('no_show_rate')).toBe('Target: below each owner’s own rate');
    expect(sampleWords('onboarding_completion', 1)).toBe('from 1 sign-up');
    expect(sampleWords('booking_completion', 12)).toBe('from 12 visits');
  });

  it('shows every metric but first reply in a group, once', () => {
    const grouped = PILOT_METRIC_GROUPS.flatMap((group) => group.keys);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped, 'first_reply_time'].sort()).toEqual(Object.keys(PILOT_METRIC_LABEL).sort());
  });

  it('gives email’s share of each channel (the top-up, AC-X-49)', () => {
    expect(emailShareWords(0, 0)).toBe('None yet');
    expect(emailShareWords(2, 6)).toBe('2 by email of 6 (33%)');
    expect(
      channelRows({
        requestsInApp: 4,
        requestsByEmail: 2,
        publicByForm: 1,
        publicByEmail: 1,
        repliesInApp: 3,
        repliesByEmail: 1,
        inboundHeld: 1,
        inboundIgnored: 2,
        inboundRefused: 0,
      }),
    ).toEqual([
      { label: 'New requests', value: '2 by email of 6 (33%)' },
      { label: 'Owners’ replies', value: '1 by email of 4 (25%)' },
      { label: 'Signed out', value: '1 by email of 2 (50%)' },
      { label: 'Mail not landed', value: '1 held · 2 ignored · 0 refused' },
    ]);
  });

  it('lists what stands beside the first-reply median (AC-X-48)', () => {
    expect(
      firstReplyRows({
        requests: 6,
        answered: 5,
        answeredWithinDay: 4,
        waiting: 1,
        waitingOverDay: 1,
        medianMinutes: 95,
        slowestMinutes: 26 * 60,
        publicAnswered: 1,
        publicOpen: 2,
      }),
    ).toEqual([
      { label: 'Slowest', value: '1 d 2 h' },
      { label: 'Within a day', value: '4 of 5 answered' },
      { label: 'Waiting', value: '1 (1 over a day)' },
      { label: 'Signed out', value: '1 answered · 2 open' },
    ]);
  });
});

describe('the pilot metrics page’s words, part 2 (S59.4.2)', () => {
  it('says the AI cost in dollars a month, and the part 2 targets as the scorecard does', () => {
    expect(metricValueWords({ key: 'ai_cost', value: 174 })).toBe('$1.74');
    expect(metricValueWords({ key: 'ai_cost', value: 300 })).toBe('$3');
    expect(targetWords('weekly_active_owners')).toBe('Target: at least 60%');
    expect(targetWords('cards_vs_chat')).toBe('Target: at least 70%');
    expect(targetWords('ai_approval_rate')).toBe('Target: 70–90%');
    expect(targetWords('ai_correction_rate')).toBe('Target: at most 10%');
    expect(targetWords('undo_rate')).toBe('Target: below 1%');
    expect(targetWords('ai_cost')).toBe('Target: at most $3, priced high');
    expect(targetWords('rebook_rate')).toBe('Target: 10 points above each owner’s own rate');
    expect(sampleWords('weekly_active_owners', 1)).toBe('from 1 owner-week');
    expect(sampleWords('rebook_rate', 8)).toBe('from 8 clients due');
  });
});

describe('the change against the period before (S59.4.2 top-up)', () => {
  const metric = (
    key: Parameters<typeof metricTrend>[0]['key'],
    value: number | null,
    previous: number | null,
    trend: 'better' | 'worse' | 'neutral' | null,
  ) => ({ key, value, previous, trend, sample: 10, status: 'tracked' as const });

  it('gives the arrow, the change in the metric’s unit and the tone', () => {
    expect(metricTrend(metric('cards_vs_chat', 75, 60.8, 'better'), 7)).toEqual({
      direction: 'up',
      tone: 'better',
      change: '14.2 pts',
      against: 'vs the 7 days before',
    });
    expect(metricTrend(metric('first_reply_time', 120, 60, 'worse'), 30)).toEqual({
      direction: 'up',
      tone: 'worse',
      change: '1 h',
      against: 'vs the 30 days before',
    });
    expect(metricTrend(metric('ai_cost', 150, 191, 'better'), 7)).toMatchObject({
      direction: 'down',
      change: '$0.41',
    });
    expect(metricTrend(metric('support_requests', 0.3, 0.1, 'worse'), 7)).toMatchObject({
      change: '0.2 a week',
    });
  });

  it('says no change when the numbers are equal, and nothing without both', () => {
    expect(metricTrend(metric('rebook_rate', 50, 50, 'neutral'), 7)).toMatchObject({
      direction: 'none',
      tone: 'neutral',
    });
    expect(metricTrend(metric('rebook_rate', 50, null, null), 7)).toBeNull();
    expect(metricTrend(metric('rebook_rate', null, 50, null), 7)).toBeNull();
  });
});
