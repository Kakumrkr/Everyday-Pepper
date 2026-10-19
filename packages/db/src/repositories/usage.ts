import {
  UsageAmountSchema,
  UsageMetricSchema,
  UsagePeriodSchema,
  type UsageMetric,
  type UsagePeriod,
} from '@pepper/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import { usageMeters } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Usage meters (ADR-0013): one counter per tenant, metric and UTC month. Run inside
// `withTenant`, ideally in the transaction of the work being metered.

/** Adds `amount` to the tenant's counter for `metric` in `period`, atomically. */
export async function addUsage(
  tx: TenantTx,
  input: { metric: UsageMetric; period: UsagePeriod; amount: number },
): Promise<void> {
  const values = {
    metric: UsageMetricSchema.parse(input.metric),
    period: UsagePeriodSchema.parse(input.period),
    amount: UsageAmountSchema.parse(input.amount),
  };
  await tx
    .insert(usageMeters)
    .values(values)
    .onConflictDoUpdate({
      target: [usageMeters.tenantId, usageMeters.metric, usageMeters.period],
      set: { amount: sql`${usageMeters.amount} + excluded.amount` },
    });
}

/** The tenant's counters for `period`, by metric. Metrics without usage are left out. */
export async function listUsage(
  tx: TenantTx,
  period: UsagePeriod,
): Promise<{ metric: UsageMetric; amount: number }[]> {
  return tx
    .select({ metric: usageMeters.metric, amount: usageMeters.amount })
    .from(usageMeters)
    .where(eq(usageMeters.period, UsagePeriodSchema.parse(period)))
    .orderBy(asc(usageMeters.metric));
}
