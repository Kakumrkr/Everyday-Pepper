import { z } from 'zod';

/**
 * What the platform meters per business (ADR-0013): AI tokens (Phase 6), emails sent (Phase 5)
 * and text segments sent (S61, ADR-0065: carriers bill by segment). Pricing and plan limits are
 * decided from this data later (open decision D7).
 */
export const UsageMetricSchema = z.enum(['llm_tokens', 'emails_sent', 'sms_segments']);
export type UsageMetric = z.infer<typeof UsageMetricSchema>;

/** A metering period: a calendar month in UTC, written `YYYY-MM`. */
export const UsagePeriodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
  .brand<'UsagePeriod'>();
export type UsagePeriod = z.infer<typeof UsagePeriodSchema>;

/** How much is added in one call: a positive whole number, at most a billion. */
export const UsageAmountSchema = z.number().int().min(1).max(1_000_000_000);
