import { describe, expect, it } from 'vitest';
import { UsageAmountSchema, UsageMetricSchema, UsagePeriodSchema } from './usage.js';

describe('usage schemas', () => {
  it('knows the metered metrics', () => {
    expect(UsageMetricSchema.options).toEqual(['llm_tokens', 'emails_sent', 'sms_segments']);
  });

  it.each(['2026-01', '2026-12'])('accepts the period %s', (period) => {
    expect(UsagePeriodSchema.parse(period)).toBe(period);
  });

  it.each(['2026-00', '2026-13', '2026-1', '26-01', '2026-01-01'])(
    'rejects the period %s',
    (period) => {
      expect(UsagePeriodSchema.safeParse(period).success).toBe(false);
    },
  );

  it.each([1, 1_000_000_000])('accepts the amount %d', (amount) => {
    expect(UsageAmountSchema.parse(amount)).toBe(amount);
  });

  it.each([0, -1, 1.5, 1_000_000_001, Number.NaN])('rejects the amount %d', (amount) => {
    expect(UsageAmountSchema.safeParse(amount).success).toBe(false);
  });
});
