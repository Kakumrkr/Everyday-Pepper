import {
  TenantIdSchema,
  type TenantId,
  type UsageMetric,
  type UsagePeriod,
} from '@pepper/contracts';
import { addUsage, listUsage, withTenant, type Database } from '@pepper/db';
import type { Clock } from '../clock.js';
import { usagePeriodOf } from '../usage-period.js';

/**
 * Meters `amount` of `metric` for a business in the current UTC month (ADR-0013). `tenantId`
 * comes from the session or a job's stored context. Work that has its own transaction should
 * call `addUsage` with `usagePeriodOf(clock.now())` inside it instead, so both commit together.
 */
export async function recordUsage(
  db: Database,
  tenantId: TenantId,
  usage: { metric: UsageMetric; amount: number },
  clock: Clock,
): Promise<void> {
  const period = usagePeriodOf(clock.now());
  await withTenant(db, TenantIdSchema.parse(tenantId), (tx) => addUsage(tx, { ...usage, period }));
}

/**
 * A business's totals for `period`, every metric listed (0 when unused). For platform use
 * (budgets, billing); a screen showing usage checks `usage.read` first.
 */
export async function usageFor(
  db: Database,
  tenantId: TenantId,
  period: UsagePeriod,
): Promise<Record<UsageMetric, number>> {
  const rows = await withTenant(db, TenantIdSchema.parse(tenantId), (tx) => listUsage(tx, period));
  const totals: Record<UsageMetric, number> = { llm_tokens: 0, emails_sent: 0 };
  for (const { metric, amount } of rows) totals[metric] = amount;
  return totals;
}
