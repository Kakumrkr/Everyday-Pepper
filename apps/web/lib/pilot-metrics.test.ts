import { describe, expect, it } from 'vitest';
import { OPS_PATHS } from './ops';
import {
  channelRows,
  emailShareWords,
  firstReplyRows,
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
