import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

/**
 * The pilot metrics page (S59.4, AC-X-47…49, scorecard §3): every business together, counts
 * and medians only, for Pepper's operators. S59.4.2 adds the AI and engagement metrics.
 */

/** The periods the page offers: the last 7 or 30 days. */
export const PILOT_METRICS_PERIODS = [7, 30] as const;

/** `GET /v1/ops/metrics?days=7|30` (7 when left out). */
export const PilotMetricsQuerySchema = z
  .object({
    days: z
      .enum(['7', '30'])
      .default('7')
      .transform((days) => (days === '7' ? 7 : 30)),
  })
  .strict();

/** A rate or median from fewer cases than this says "Not enough yet" (S59.4 D-3). */
export const PILOT_METRICS_MIN_SAMPLE = 5;

export const PILOT_METRIC_KEYS = [
  'onboarding_completion',
  'time_to_bookable',
  'time_to_first_booking',
  'booking_completion',
  'code_step_drop_off',
  'no_show_rate',
  'fill_rate',
  'waitlist_conversion',
  'support_requests',
  'first_reply_time',
] as const;
export const PilotMetricKeySchema = z.enum(PILOT_METRIC_KEYS);
export type PilotMetricKey = z.infer<typeof PilotMetricKeySchema>;

/** How a metric's number reads: a share in percent, minutes, or requests a business a week. */
export type PilotMetricUnit = 'percent' | 'minutes' | 'per_business_week';

/**
 * Each metric's unit and pilot target (scorecard §3): met at or above (`at_least`) or at or
 * below (`at_most`) the value, or only tracked until the pilot sets one (fill rate after week
 * 2; no-shows against each owner's own baseline). First-reply time also needs every request
 * answered within a day.
 */
export const PILOT_METRIC_TARGETS: Record<
  PilotMetricKey,
  { unit: PilotMetricUnit; target: { kind: 'at_least' | 'at_most'; value: number } | null }
> = {
  onboarding_completion: { unit: 'percent', target: { kind: 'at_least', value: 80 } },
  time_to_bookable: { unit: 'minutes', target: { kind: 'at_most', value: 10 } },
  time_to_first_booking: { unit: 'minutes', target: { kind: 'at_most', value: 15 } },
  booking_completion: { unit: 'percent', target: { kind: 'at_least', value: 60 } },
  code_step_drop_off: { unit: 'percent', target: { kind: 'at_most', value: 15 } },
  no_show_rate: { unit: 'percent', target: null },
  fill_rate: { unit: 'percent', target: null },
  waitlist_conversion: { unit: 'percent', target: { kind: 'at_least', value: 30 } },
  support_requests: { unit: 'per_business_week', target: { kind: 'at_most', value: 1 } },
  first_reply_time: { unit: 'minutes', target: { kind: 'at_most', value: 240 } },
};

/** `met`/`missed` against the target; `tracked` without one; `not_enough` cases yet. */
export const PilotMetricStatusSchema = z.enum(['met', 'missed', 'tracked', 'not_enough']);
export type PilotMetricStatus = z.infer<typeof PilotMetricStatusSchema>;

const Count = z.number().int().nonnegative();

export const PilotMetricSchema = z.object({
  key: PilotMetricKeySchema,
  /** The number in its unit, one decimal at most; `null` with no case at all. */
  value: z.number().nonnegative().nullable(),
  /** How many cases it is from (sign-ups, visits, bookings, offers, requests, businesses). */
  sample: Count,
  status: PilotMetricStatusSchema,
});
export type PilotMetric = z.infer<typeof PilotMetricSchema>;

/** `GET /v1/ops/metrics`. */
export const PilotMetricsSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  since: UtcDateTimeSchema,
  until: UtcDateTimeSchema,
  /** Businesses with a member; bookable ones reached a service, staff and hours. */
  businesses: Count,
  bookableBusinesses: Count,
  metrics: z.array(PilotMetricSchema),
  /** Business requests opened in the period (AC-X-48). */
  firstReply: z.object({
    requests: Count,
    answered: Count,
    answeredWithinDay: Count,
    waiting: Count,
    waitingOverDay: Count,
    medianMinutes: z.number().nonnegative().nullable(),
    slowestMinutes: z.number().nonnegative().nullable(),
    publicAnswered: Count,
    publicOpen: Count,
  }),
  /** By email vs in the app (AC-X-49). */
  channels: z.object({
    requestsInApp: Count,
    requestsByEmail: Count,
    publicByForm: Count,
    publicByEmail: Count,
    repliesInApp: Count,
    repliesByEmail: Count,
    inboundHeld: Count,
    inboundIgnored: Count,
    inboundRefused: Count,
  }),
});
export type PilotMetrics = z.infer<typeof PilotMetricsSchema>;
