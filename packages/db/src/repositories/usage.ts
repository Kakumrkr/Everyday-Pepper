import {
  UsageAmountSchema,
  UsageMetricSchema,
  UsagePeriodSchema,
  type UsageMetric,
  type UsagePeriod,
} from '@pepper/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
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

/**
 * Reserves `amount` of `metric` in `period` if the counter stays within `limit`, atomically
 * (one conditional upsert of the counter's row): of many concurrent reservations, only those
 * that fit succeed. Returns whether it was reserved. `settleUsage` later corrects the
 * reservation to what was really used (ADR-0030: a hard budget that holds under concurrency).
 */
export async function reserveUsage(
  tx: TenantTx,
  input: { metric: UsageMetric; period: UsagePeriod; amount: number; limit: number },
): Promise<boolean> {
  const metric = UsageMetricSchema.parse(input.metric);
  const period = UsagePeriodSchema.parse(input.period);
  const amount = UsageAmountSchema.parse(input.amount);
  const limit = UsageAmountSchema.parse(input.limit);
  if (amount > limit) return false;
  const rows = await tx
    .insert(usageMeters)
    .values({ metric, period, amount })
    .onConflictDoUpdate({
      target: [usageMeters.tenantId, usageMeters.metric, usageMeters.period],
      set: { amount: sql`${usageMeters.amount} + excluded.amount` },
      setWhere: sql`${usageMeters.amount} + excluded.amount <= ${limit}`,
    })
    .returning({ amount: usageMeters.amount });
  return rows.length === 1;
}

/**
 * Corrects a reservation by `delta` (what was used minus what was reserved; negative gives
 * back). The counter never goes below zero.
 */
export async function settleUsage(
  tx: TenantTx,
  input: { metric: UsageMetric; period: UsagePeriod; delta: number },
): Promise<void> {
  const metric = UsageMetricSchema.parse(input.metric);
  const period = UsagePeriodSchema.parse(input.period);
  const delta = z.int().min(-1_000_000_000).max(1_000_000_000).parse(input.delta);
  if (delta === 0) return;
  await tx
    .insert(usageMeters)
    .values({ metric, period, amount: Math.max(delta, 0) })
    .onConflictDoUpdate({
      target: [usageMeters.tenantId, usageMeters.metric, usageMeters.period],
      set: { amount: sql`GREATEST(${usageMeters.amount} + ${delta}, 0)` },
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
