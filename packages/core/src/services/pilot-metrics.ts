import {
  PILOT_METRIC_TARGETS,
  PILOT_METRICS_MIN_SAMPLE,
  PilotMetricsSchema,
  type PilotMetric,
  type PilotMetricKey,
  type PilotMetrics,
} from '@pepper/contracts';
import type { PlatformMetrics, SupportMetrics } from '@pepper/db';

/** One decimal at most: the page shows whole numbers or tenths. */
function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : tenths((part / whole) * 100);
}

/**
 * A metric against its scorecard target (S59.4, AC-X-47): "not enough" from fewer than
 * `minimum` cases (no number at all from none), `tracked` without a target.
 */
export function judgePilotMetric(
  key: PilotMetricKey,
  value: number | null,
  sample: number,
  options: { minimum?: number; alsoMet?: boolean } = {},
): PilotMetric {
  const minimum = options.minimum ?? PILOT_METRICS_MIN_SAMPLE;
  const shown = sample === 0 || value === null ? null : tenths(value);
  const { target } = PILOT_METRIC_TARGETS[key];
  if (shown === null || sample < minimum) {
    return { key, value: shown, sample, status: 'not_enough' };
  }
  if (target === null) return { key, value: shown, sample, status: 'tracked' };
  const withinTarget = target.kind === 'at_least' ? shown >= target.value : shown <= target.value;
  const met = withinTarget && (options.alsoMet ?? true);
  return { key, value: shown, sample, status: met ? 'met' : 'missed' };
}

/** The page's numbers from the platform's and support's counts (S59.4, AC-X-47…49). */
export function buildPilotMetrics(input: {
  days: 7 | 30;
  since: Date;
  until: Date;
  platform: PlatformMetrics;
  support: SupportMetrics;
  inbound: { held: number; ignored: number; refused: number };
}): PilotMetrics {
  const { platform, support, days } = input;
  const weeks = days / 7;
  const metrics: PilotMetric[] = [
    judgePilotMetric(
      'onboarding_completion',
      share(platform.reachedBookable, platform.signups),
      platform.signups,
    ),
    judgePilotMetric('time_to_bookable', platform.minutesToBookable, platform.reachedBookable),
    judgePilotMetric(
      'time_to_first_booking',
      platform.minutesToFirstBooking,
      platform.reachedFirstBooking,
    ),
    judgePilotMetric(
      'booking_completion',
      share(platform.funnelConfirmed, platform.funnelStarts),
      platform.funnelStarts,
    ),
    judgePilotMetric(
      'code_step_drop_off',
      share(platform.funnelLeftAtCode, platform.funnelReachedCode),
      platform.funnelReachedCode,
    ),
    judgePilotMetric(
      'no_show_rate',
      share(platform.noShows, platform.pastBookings),
      platform.pastBookings,
    ),
    judgePilotMetric(
      'fill_rate',
      share(platform.refilledSlots, platform.cancelledSlots),
      platform.cancelledSlots,
    ),
    judgePilotMetric(
      'waitlist_conversion',
      share(platform.offersClaimed, platform.offersSent),
      platform.offersSent,
    ),
    // A rate per business, not of cases: one bookable business is enough to show it.
    judgePilotMetric(
      'support_requests',
      platform.bookableBusinesses === 0
        ? null
        : support.requests / platform.bookableBusinesses / weeks,
      platform.bookableBusinesses,
      { minimum: 1 },
    ),
    // Met only when every request also had its first reply within a day (C14 "the same day").
    judgePilotMetric('first_reply_time', support.medianMinutes, support.answered, {
      alsoMet: support.answeredWithinDay === support.answered && support.waitingOverDay === 0,
    }),
  ];
  return PilotMetricsSchema.parse({
    days,
    since: input.since.toISOString(),
    until: input.until.toISOString(),
    businesses: platform.businesses,
    bookableBusinesses: platform.bookableBusinesses,
    metrics,
    firstReply: {
      requests: support.requests,
      answered: support.answered,
      answeredWithinDay: support.answeredWithinDay,
      waiting: support.waiting,
      waitingOverDay: support.waitingOverDay,
      medianMinutes: support.medianMinutes === null ? null : tenths(support.medianMinutes),
      slowestMinutes: support.slowestMinutes === null ? null : tenths(support.slowestMinutes),
      publicAnswered: support.publicAnswered,
      publicOpen: support.publicOpen,
    },
    channels: {
      requestsInApp: support.requestsInApp,
      requestsByEmail: support.requestsByEmail,
      publicByForm: support.publicByForm,
      publicByEmail: support.publicByEmail,
      repliesInApp: support.repliesInApp,
      repliesByEmail: support.repliesByEmail,
      inboundHeld: input.inbound.held,
      inboundIgnored: input.inbound.ignored,
      inboundRefused: input.inbound.refused,
    },
  });
}
