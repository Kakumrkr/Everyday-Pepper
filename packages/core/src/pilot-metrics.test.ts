import { describe, expect, it } from 'vitest';
import { buildPilotMetrics, judgePilotMetric } from './services/pilot-metrics.js';

// The pilot metrics page's judgement (S59.4, AC-X-47…49): targets, "Not enough yet", units.

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
  const inbound = { held: 1, ignored: 2, refused: 0 };

  it('gives every metric of the page its number and judgement', () => {
    const page = buildPilotMetrics({ ...period, platform, support, inbound });
    const byKey = Object.fromEntries(page.metrics.map((metric) => [metric.key, metric]));
    expect(byKey).toEqual({
      onboarding_completion: { key: 'onboarding_completion', value: 80, sample: 10, status: 'met' },
      time_to_bookable: { key: 'time_to_bookable', value: 9, sample: 8, status: 'met' },
      time_to_first_booking: {
        key: 'time_to_first_booking',
        value: 22,
        sample: 5,
        status: 'missed',
      },
      booking_completion: { key: 'booking_completion', value: 65, sample: 20, status: 'met' },
      code_step_drop_off: { key: 'code_step_drop_off', value: 20, sample: 15, status: 'missed' },
      no_show_rate: { key: 'no_show_rate', value: 5, sample: 40, status: 'tracked' },
      fill_rate: { key: 'fill_rate', value: 33.3, sample: 6, status: 'tracked' },
      waitlist_conversion: {
        key: 'waitlist_conversion',
        value: 50,
        sample: 4,
        status: 'not_enough',
      },
      support_requests: { key: 'support_requests', value: 1.5, sample: 4, status: 'missed' },
      first_reply_time: { key: 'first_reply_time', value: 95.6, sample: 5, status: 'met' },
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
      inbound,
    });
    expect(late.metrics.find((m) => m.key === 'first_reply_time')?.status).toBe('missed');
    const waiting = buildPilotMetrics({
      ...period,
      platform,
      support: { ...support, waitingOverDay: 1 },
      inbound,
    });
    expect(waiting.metrics.find((m) => m.key === 'first_reply_time')?.status).toBe('missed');
  });

  it('counts support requests a business a week over 30 days, none without a business', () => {
    const month = buildPilotMetrics({ ...period, days: 30, platform, support, inbound });
    expect(month.metrics.find((m) => m.key === 'support_requests')?.value).toBe(0.4);
    const none = buildPilotMetrics({
      ...period,
      platform: { ...platform, businesses: 0 },
      support,
      inbound,
    });
    expect(none.metrics.find((m) => m.key === 'support_requests')).toMatchObject({
      value: null,
      status: 'not_enough',
    });
  });
});
