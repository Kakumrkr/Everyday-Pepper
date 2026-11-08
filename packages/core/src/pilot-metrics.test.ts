import { describe, expect, it } from 'vitest';
import {
  aiCostCents,
  buildPilotMetrics,
  judgePilotMetric,
  withTrend,
} from './services/pilot-metrics.js';

// The pilot metrics page's judgement (S59.4, S59.4.2, AC-X-47…53): targets, "Not enough yet",
// units and the change against the period before.

const platform = {
  businesses: 4,
  bookableBusinesses: 2,
  signups: 10,
  reachedBookable: 8,
  reachedFirstBooking: 5,
  minutesToBookable: 9.04,
  minutesToFirstBooking: 22,
  funnelStarts: 20,
  funnelConfirmed: 13,
  funnelReachedCode: 15,
  funnelLeftAtCode: 3,
  pastBookings: 40,
  noShows: 2,
  cancelledSlots: 6,
  refilledSlots: 2,
  offersSent: 4,
  offersClaimed: 2,
};
const support = {
  requests: 6,
  answered: 5,
  answeredWithinDay: 5,
  waiting: 1,
  waitingOverDay: 0,
  medianMinutes: 95.55,
  slowestMinutes: 600,
  requestsInApp: 4,
  requestsByEmail: 2,
  repliesInApp: 3,
  repliesByEmail: 1,
  publicByForm: 1,
  publicByEmail: 1,
  publicAnswered: 1,
  publicOpen: 1,
};
const ai = {
  ownerWeeks: 10,
  activeOwnerWeeks: 7,
  activeBusinesses: 4,
  cardActions: 30,
  chatTurns: 10,
  proposalsShown: 20,
  proposalsApproved: 19,
  proposalsEdited: 2,
  proposalsAskedAgain: 1,
  actionsExecuted: 50,
  actionsUndoneWrong: 0,
  // $0.60 + $0.02 + $1.00 = $1.62 this week over 4 businesses: 40.5 cents a week, 173.6 a month.
  inputTokens: 500_000,
  cachedInputTokens: 200_000,
  outputTokens: 100_000,
  rebookDue: 8,
  rebooked: 5,
};
const inbound = { held: 1, ignored: 2, refused: 0 };
const period = {
  days: 7 as const,
  since: new Date('2026-11-01T12:00:00Z'),
  until: new Date('2026-11-08T12:00:00Z'),
};

describe('judgePilotMetric', () => {
  it('meets an at-least or at-most target at its edge', () => {
    expect(judgePilotMetric('onboarding_completion', 80, 10).status).toBe('met');
    expect(judgePilotMetric('onboarding_completion', 79.9, 10).status).toBe('missed');
    expect(judgePilotMetric('time_to_bookable', 10, 5).status).toBe('met');
    expect(judgePilotMetric('time_to_bookable', 10.1, 5).status).toBe('missed');
  });

  it('says not enough below 5 cases, with no number from none', () => {
    expect(judgePilotMetric('booking_completion', 50, 4)).toEqual({
      key: 'booking_completion',
      value: 50,
      sample: 4,
      status: 'not_enough',
      previous: null,
      trend: null,
    });
    expect(judgePilotMetric('booking_completion', null, 0)).toMatchObject({
      value: null,
      status: 'not_enough',
    });
  });

  it('only tracks a metric without a target', () => {
    expect(judgePilotMetric('fill_rate', 33.3, 6).status).toBe('tracked');
  });
});

describe('buildPilotMetrics', () => {
  const entry = (key: string, value: number, sample: number, status: string) => ({
    key,
    value,
    sample,
    status,
    previous: null,
    trend: null,
  });

  it('gives every metric of the page its number and judgement', () => {
    const page = buildPilotMetrics({ ...period, platform, support, ai, inbound });
    const byKey = Object.fromEntries(page.metrics.map((metric) => [metric.key, metric]));
    expect(byKey).toEqual({
      onboarding_completion: {
        key: 'onboarding_completion',
        value: 80,
        sample: 10,
        status: 'met',
        previous: null,
        trend: null,
      },
      time_to_bookable: {
        key: 'time_to_bookable',
        value: 9,
        sample: 8,
        status: 'met',
        previous: null,
        trend: null,
      },
      time_to_first_booking: {
        key: 'time_to_first_booking',
        value: 22,
        sample: 5,
        status: 'missed',
        previous: null,
        trend: null,
      },
      booking_completion: {
        key: 'booking_completion',
        value: 65,
        sample: 20,
        status: 'met',
        previous: null,
        trend: null,
      },
      code_step_drop_off: {
        key: 'code_step_drop_off',
        value: 20,
        sample: 15,
        status: 'missed',
        previous: null,
        trend: null,
      },
      no_show_rate: {
        key: 'no_show_rate',
        value: 5,
        sample: 40,
        status: 'tracked',
        previous: null,
        trend: null,
      },
      fill_rate: {
        key: 'fill_rate',
        value: 33.3,
        sample: 6,
        status: 'tracked',
        previous: null,
        trend: null,
      },
      waitlist_conversion: {
        key: 'waitlist_conversion',
        value: 50,
        sample: 4,
        status: 'not_enough',
        previous: null,
        trend: null,
      },
      support_requests: {
        key: 'support_requests',
        value: 1.5,
        sample: 4,
        status: 'missed',
        previous: null,
        trend: null,
      },
      first_reply_time: {
        key: 'first_reply_time',
        value: 95.6,
        sample: 5,
        status: 'met',
        previous: null,
        trend: null,
      },
      weekly_active_owners: entry('weekly_active_owners', 70, 10, 'met'),
      cards_vs_chat: entry('cards_vs_chat', 75, 40, 'met'),
      // 19 of 20: above the 70–90% range is missed too (rubber-stamping).
      ai_approval_rate: entry('ai_approval_rate', 95, 20, 'missed'),
      ai_correction_rate: entry('ai_correction_rate', 13.6, 22, 'missed'),
      undo_rate: entry('undo_rate', 0, 50, 'met'),
      ai_cost: entry('ai_cost', 173.6, 4, 'met'),
      rebook_rate: entry('rebook_rate', 62.5, 8, 'tracked'),
    });
    expect(page.firstReply).toMatchObject({ medianMinutes: 95.6, slowestMinutes: 600 });
    expect(page.channels).toMatchObject({ requestsByEmail: 2, inboundHeld: 1, inboundIgnored: 2 });
    expect(page.since).toBe('2026-11-01T12:00:00.000Z');
  });

  it('misses first-reply time when a request waited more than a day, whatever the median', () => {
    const late = buildPilotMetrics({
      ...period,
      platform,
      support: { ...support, answeredWithinDay: 4 },
      ai,
      inbound,
    });
    expect(late.metrics.find((m) => m.key === 'first_reply_time')?.status).toBe('missed');
    const waiting = buildPilotMetrics({
      ...period,
      platform,
      support: { ...support, waitingOverDay: 1 },
      ai,
      inbound,
    });
    expect(waiting.metrics.find((m) => m.key === 'first_reply_time')?.status).toBe('missed');
  });

  it('counts support requests a business a week over 30 days, none without a business', () => {
    const month = buildPilotMetrics({ ...period, days: 30, platform, support, ai, inbound });
    expect(month.metrics.find((m) => m.key === 'support_requests')?.value).toBe(0.4);
    const none = buildPilotMetrics({
      ...period,
      platform: { ...platform, businesses: 0 },
      support,
      ai,
      inbound,
    });
    expect(none.metrics.find((m) => m.key === 'support_requests')).toMatchObject({
      value: null,
      status: 'not_enough',
    });
  });
});

describe('the part 2 targets (S59.4.2)', () => {
  it('meets a range at both ends and a "below" target only under it', () => {
    expect(judgePilotMetric('ai_approval_rate', 70, 10).status).toBe('met');
    expect(judgePilotMetric('ai_approval_rate', 90, 10).status).toBe('met');
    expect(judgePilotMetric('ai_approval_rate', 69.9, 10).status).toBe('missed');
    expect(judgePilotMetric('ai_approval_rate', 90.1, 10).status).toBe('missed');
    expect(judgePilotMetric('undo_rate', 0.9, 200).status).toBe('met');
    expect(judgePilotMetric('undo_rate', 1, 200).status).toBe('missed');
  });

  it('prices the chat at the strong model, cached input at its own rate', () => {
    expect(aiCostCents(ai)).toBeCloseTo(162, 6);
    expect(aiCostCents({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('scales AI cost to a month and shows none without an active business', () => {
    const month = buildPilotMetrics({ ...period, days: 30, platform, support, ai, inbound });
    expect(month.metrics.find((m) => m.key === 'ai_cost')?.value).toBe(40.5);
    const idle = buildPilotMetrics({
      ...period,
      platform,
      support,
      ai: { ...ai, activeBusinesses: 0 },
      inbound,
    });
    expect(idle.metrics.find((m) => m.key === 'ai_cost')).toMatchObject({
      value: null,
      status: 'not_enough',
    });
  });

  it('counts an edit as a correction and a case, never a shown proposal', () => {
    const page = buildPilotMetrics({
      ...period,
      platform,
      support,
      ai: { ...ai, proposalsShown: 3, proposalsEdited: 2, proposalsAskedAgain: 0 },
      inbound,
    });
    expect(page.metrics.find((m) => m.key === 'ai_correction_rate')).toMatchObject({
      value: 40,
      sample: 5,
    });
    expect(page.metrics.find((m) => m.key === 'ai_approval_rate')?.status).toBe('not_enough');
  });
});

describe('the change against the period before (S59.4.2 top-up)', () => {
  it('is better or worse by the direction that counts', () => {
    expect(
      withTrend(
        judgePilotMetric('cards_vs_chat', 75, 40),
        judgePilotMetric('cards_vs_chat', 60, 30),
      ),
    ).toMatchObject({ previous: 60, trend: 'better' });
    expect(
      withTrend(
        judgePilotMetric('first_reply_time', 120, 10),
        judgePilotMetric('first_reply_time', 60, 10),
      ),
    ).toMatchObject({ previous: 60, trend: 'worse' });
    expect(
      withTrend(judgePilotMetric('rebook_rate', 50, 10), judgePilotMetric('rebook_rate', 50, 10)),
    ).toMatchObject({ previous: 50, trend: 'neutral' });
  });

  it('reads a range by how near it came, neutral within it', () => {
    const approval = (value: number) => judgePilotMetric('ai_approval_rate', value, 20);
    expect(withTrend(approval(92), approval(98))).toMatchObject({ trend: 'better' });
    expect(withTrend(approval(65), approval(75))).toMatchObject({ trend: 'worse' });
    expect(withTrend(approval(85), approval(72))).toMatchObject({ trend: 'neutral' });
  });

  it('shows no change when either period had too few cases', () => {
    expect(
      withTrend(
        judgePilotMetric('cards_vs_chat', 75, 40),
        judgePilotMetric('cards_vs_chat', 50, 4),
      ),
    ).toMatchObject({ previous: null, trend: null });
    expect(
      withTrend(
        judgePilotMetric('cards_vs_chat', 75, 4),
        judgePilotMetric('cards_vs_chat', 50, 40),
      ),
    ).toMatchObject({ previous: 50, trend: null });
  });

  it('gives every metric of the page its number from the period before', () => {
    const page = buildPilotMetrics({
      ...period,
      platform,
      support,
      ai,
      inbound,
      before: {
        platform: { ...platform, reachedBookable: 6 },
        support,
        ai: { ...ai, activeOwnerWeeks: 8 },
      },
    });
    const byKey = Object.fromEntries(page.metrics.map((metric) => [metric.key, metric]));
    expect(byKey['onboarding_completion']).toMatchObject({
      value: 80,
      previous: 60,
      trend: 'better',
    });
    expect(byKey['weekly_active_owners']).toMatchObject({
      value: 70,
      previous: 80,
      trend: 'worse',
    });
    expect(byKey['undo_rate']).toMatchObject({ previous: 0, trend: 'neutral' });
    // Not enough cases before: no number to compare.
    expect(byKey['waitlist_conversion']).toMatchObject({ previous: null, trend: null });
  });
});
