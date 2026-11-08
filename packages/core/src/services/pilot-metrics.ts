import {
  PILOT_METRIC_TARGETS,
  PILOT_METRICS_MIN_SAMPLE,
  PilotMetricsSchema,
  type PilotMetric,
  type PilotMetricKey,
  type PilotMetricTarget,
  type PilotMetrics,
} from '@pepper/contracts';
import type { AiMetrics, PlatformMetrics, SupportMetrics } from '@pepper/db';

/**
 * What the chat's tokens cost, in US dollars a million (S59.4.2 D-3): the strong model's rate
 * (gpt-6.1-sol in `packages/ai/evals/prices.json`, checked 2026-10-23). Turns don't record
 * which model answered, so every turn is priced as the dearer one: the page's AI cost is an
 * upper bound. Re-check with the price table.
 */
export const PILOT_AI_PRICE_PER_MILLION_USD = { input: 2, cachedInput: 0.1, output: 10 } as const;

/** The chat's tokens in US cents at `PILOT_AI_PRICE_PER_MILLION_USD` (cached input included in input). */
export function aiCostCents(tokens: {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}): number {
  const price = PILOT_AI_PRICE_PER_MILLION_USD;
  const uncached = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens);
  const usd =
    (uncached * price.input +
      tokens.cachedInputTokens * price.cachedInput +
      tokens.outputTokens * price.output) /
    1_000_000;
  return usd * 100;
}

/** One decimal at most: the page shows whole numbers or tenths. */
function tenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : tenths((part / whole) * 100);
}

function withinTarget(target: PilotMetricTarget, value: number): boolean {
  switch (target.kind) {
    case 'at_least':
      return value >= target.value;
    case 'at_most':
      return value <= target.value;
    case 'below':
      return value < target.value;
    case 'between':
      return value >= target.min && value <= target.max;
  }
}

/**
 * A metric against its scorecard target (S59.4, AC-X-47): "not enough" from fewer than
 * `minimum` cases (no number at all from none), `tracked` without a target. No change against
 * the period before yet (`withTrend`).
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
  const judged = { key, value: shown, sample, previous: null, trend: null };
  if (shown === null || sample < minimum) return { ...judged, status: 'not_enough' };
  if (target === null) return { ...judged, status: 'tracked' };
  const met = withinTarget(target, shown) && (options.alsoMet ?? true);
  return { ...judged, status: met ? 'met' : 'missed' };
}

/** How far a number is outside a range target (0 within it). */
function distanceFrom(target: PilotMetricTarget, value: number): number {
  if (target.kind !== 'between') return 0;
  return Math.max(target.min - value, value - target.max, 0);
}

/**
 * A metric with its number over the period before (S59.4.2 top-up): kept only when that period
 * had enough cases to judge; the change is better or worse by the metric's direction, or for a
 * range by how near it came (neutral when equal, or both within).
 */
export function withTrend(current: PilotMetric, before: PilotMetric): PilotMetric {
  const previous = before.status === 'not_enough' ? null : before.value;
  if (current.status === 'not_enough' || current.value === null || previous === null) {
    return { ...current, previous, trend: null };
  }
  const { better, target } = PILOT_METRIC_TARGETS[current.key];
  let gain: number;
  if (better === 'higher') gain = current.value - previous;
  else if (better === 'lower') gain = previous - current.value;
  else
    gain =
      target === null ? 0 : distanceFrom(target, previous) - distanceFrom(target, current.value);
  const trend = gain > 0 ? 'better' : gain < 0 ? 'worse' : 'neutral';
  return { ...current, previous, trend };
}

interface PeriodCounts {
  platform: PlatformMetrics;
  support: SupportMetrics;
  ai: AiMetrics;
}

/** Every metric of the page from one period's counts, in the page's order. */
function judgeAll(days: 7 | 30, counts: PeriodCounts): PilotMetric[] {
  const { platform, support, ai } = counts;
  const weeks = days / 7;
  return [
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
    // A rate per business (every business's requests over every business), not of cases: one
    // business is enough to show it.
    judgePilotMetric(
      'support_requests',
      platform.businesses === 0 ? null : support.requests / platform.businesses / weeks,
      platform.businesses,
      { minimum: 1 },
    ),
    // Met only when every request also had its first reply within a day (C14 "the same day").
    judgePilotMetric('first_reply_time', support.medianMinutes, support.answered, {
      alsoMet: support.answeredWithinDay === support.answered && support.waitingOverDay === 0,
    }),
    // Owner-weeks with 4 or more active days, of every owner's whole weeks in the period.
    judgePilotMetric(
      'weekly_active_owners',
      share(ai.activeOwnerWeeks, ai.ownerWeeks),
      ai.ownerWeeks,
    ),
    judgePilotMetric(
      'cards_vs_chat',
      share(ai.cardActions, ai.cardActions + ai.chatTurns),
      ai.cardActions + ai.chatTurns,
    ),
    judgePilotMetric(
      'ai_approval_rate',
      share(ai.proposalsApproved, ai.proposalsShown),
      ai.proposalsShown,
    ),
    // Edited proposals were replaced before the end, so they join the shown ones as cases.
    judgePilotMetric(
      'ai_correction_rate',
      share(ai.proposalsEdited + ai.proposalsAskedAgain, ai.proposalsShown + ai.proposalsEdited),
      ai.proposalsShown + ai.proposalsEdited,
    ),
    judgePilotMetric(
      'undo_rate',
      share(ai.actionsUndoneWrong, ai.actionsExecuted),
      ai.actionsExecuted,
    ),
    // Cents a business that used Pepper in the period, scaled to a 30-day month; one business is
    // enough to show it, as for support requests.
    judgePilotMetric(
      'ai_cost',
      ai.activeBusinesses === 0 ? null : (aiCostCents(ai) / ai.activeBusinesses) * (30 / days),
      ai.activeBusinesses,
      { minimum: 1 },
    ),
    judgePilotMetric('rebook_rate', share(ai.rebooked, ai.rebookDue), ai.rebookDue),
  ];
}

/**
 * The page's numbers from the platform's, support's and the AI's counts (S59.4, S59.4.2,
 * AC-X-47…53), each with its change against the period before when that one is given.
 */
export function buildPilotMetrics(input: {
  days: 7 | 30;
  since: Date;
  until: Date;
  platform: PlatformMetrics;
  support: SupportMetrics;
  ai: AiMetrics;
  inbound: { held: number; ignored: number; refused: number };
  before?: PeriodCounts;
}): PilotMetrics {
  const { platform, support, days } = input;
  const current = judgeAll(days, input);
  const before = input.before === undefined ? undefined : judgeAll(days, input.before);
  const metrics = current.map((metric, index) => {
    const earlier = before?.[index];
    return earlier === undefined ? metric : withTrend(metric, earlier);
  });
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
