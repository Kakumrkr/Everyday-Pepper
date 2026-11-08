import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

/**
 * The pilot metrics page (S59.4, AC-X-47…49, scorecard §3): every business together, counts
 * and medians only, for Pepper's operators. S59.4.2 adds engagement, the AI's cards, its cost
 * and the rebook rate (AC-X-50…53), and each metric's change against the period before.
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
  'weekly_active_owners',
  'cards_vs_chat',
  'ai_approval_rate',
  'ai_correction_rate',
  'undo_rate',
  'ai_cost',
  'rebook_rate',
] as const;
export const PilotMetricKeySchema = z.enum(PILOT_METRIC_KEYS);
export type PilotMetricKey = z.infer<typeof PilotMetricKeySchema>;

/**
 * How a metric's number reads: a share in percent, minutes, requests a business a week, or US
 * cents (AI cost a business a month).
 */
export type PilotMetricUnit = 'percent' | 'minutes' | 'per_business_week' | 'cents';

/**
 * A scorecard target: met at or above (`at_least`), at or below (`at_most`), strictly below
 * (`below`) the value, or within a range (`between`, both ends included).
 */
export type PilotMetricTarget =
  | { kind: 'at_least' | 'at_most' | 'below'; value: number }
  | { kind: 'between'; min: number; max: number };

/**
 * Each metric's unit, pilot target (scorecard §3) and which way is better (for the change
 * against the period before; `null` for a range, where nearer the range is better). A metric
 * is only tracked until the pilot sets a target (fill rate after week 2; no-shows against each
 * owner's own baseline; the rebook rate against the period before). First-reply time also
 * needs every request answered within a day.
 */
export const PILOT_METRIC_TARGETS: Record<
  PilotMetricKey,
  { unit: PilotMetricUnit; target: PilotMetricTarget | null; better: 'higher' | 'lower' | null }
> = {
  onboarding_completion: {
    unit: 'percent',
    target: { kind: 'at_least', value: 80 },
    better: 'higher',
  },
  time_to_bookable: { unit: 'minutes', target: { kind: 'at_most', value: 10 }, better: 'lower' },
  time_to_first_booking: {
    unit: 'minutes',
    target: { kind: 'at_most', value: 15 },
    better: 'lower',
  },
  booking_completion: {
    unit: 'percent',
    target: { kind: 'at_least', value: 60 },
    better: 'higher',
  },
  code_step_drop_off: { unit: 'percent', target: { kind: 'at_most', value: 15 }, better: 'lower' },
  no_show_rate: { unit: 'percent', target: null, better: 'lower' },
  fill_rate: { unit: 'percent', target: null, better: 'higher' },
  waitlist_conversion: {
    unit: 'percent',
    target: { kind: 'at_least', value: 30 },
    better: 'higher',
  },
  support_requests: {
    unit: 'per_business_week',
    target: { kind: 'at_most', value: 1 },
    better: 'lower',
  },
  first_reply_time: { unit: 'minutes', target: { kind: 'at_most', value: 240 }, better: 'lower' },
  weekly_active_owners: {
    unit: 'percent',
    target: { kind: 'at_least', value: 60 },
    better: 'higher',
  },
  cards_vs_chat: { unit: 'percent', target: { kind: 'at_least', value: 70 }, better: 'higher' },
  ai_approval_rate: {
    unit: 'percent',
    target: { kind: 'between', min: 70, max: 90 },
    better: null,
  },
  ai_correction_rate: {
    unit: 'percent',
    target: { kind: 'at_most', value: 10 },
    better: 'lower',
  },
  undo_rate: { unit: 'percent', target: { kind: 'below', value: 1 }, better: 'lower' },
  ai_cost: { unit: 'cents', target: { kind: 'at_most', value: 300 }, better: 'lower' },
  rebook_rate: { unit: 'percent', target: null, better: 'higher' },
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
  /**
   * The same metric over the period just before (7 or 30 days); `null` when that period had
   * too few cases to judge (S59.4.2 top-up).
   */
  previous: z.number().nonnegative().nullable(),
  /**
   * Whether the change since then is for the better, the worse, or neither (no change, or
   * still within a range target); `null` without both numbers.
   */
  trend: z.enum(['better', 'worse', 'neutral']).nullable(),
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
