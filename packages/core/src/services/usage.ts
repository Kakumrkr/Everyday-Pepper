import {
  TenantIdSchema,
  type TenantId,
  type UsageMetric,
  type UsagePeriod,
} from '@pepper/contracts';
import {
  addUsage,
  listUsage,
  reserveUsage,
  settleUsage,
  withTenant,
  type Database,
} from '@pepper/db';
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
  const totals: Record<UsageMetric, number> = { llm_tokens: 0, emails_sent: 0, sms_segments: 0 };
  for (const { metric, amount } of rows) totals[metric] = amount;
  return totals;
}

/** A business's monthly allowance of model tokens (ADR-0030). */
export interface LlmTokenLimits {
  /** Above this the AI uses only the routine model (and says so in reports). */
  soft: number;
  /** At this the AI pauses until the next month; every screen keeps working. */
  hard: number;
}

/** The platform default: 5M tokens a month, soft at 80% (S25, user). */
export const DEFAULT_LLM_TOKEN_LIMITS: LlmTokenLimits = { soft: 4_000_000, hard: 5_000_000 };

/** Validates limits: positive whole numbers, the soft one no higher than the hard one. */
export function llmTokenLimits(hard: number, softRatio = 0.8): LlmTokenLimits {
  if (!Number.isInteger(hard) || hard < 1 || hard > 1_000_000_000) {
    throw new RangeError('The token budget must be a whole number from 1 to 1,000,000,000');
  }
  if (!(softRatio > 0 && softRatio <= 1)) throw new RangeError('The soft ratio is in (0, 1]');
  return { soft: Math.max(1, Math.floor(hard * softRatio)), hard };
}

export type LlmBudgetState = 'ok' | 'soft' | 'exhausted';

/** Where `used` tokens leave a business against its limits. */
export function llmBudgetStateOf(used: number, limits: LlmTokenLimits): LlmBudgetState {
  if (used >= limits.hard) return 'exhausted';
  if (used >= limits.soft) return 'soft';
  return 'ok';
}

/** Tokens held for one model call until it is settled with what it really used. */
export interface LlmTokenReservation {
  /** The budget after reserving: `soft` means routine model only. */
  state: Exclude<LlmBudgetState, 'exhausted'>;
  /** Corrects the reservation to the tokens the call used (0 when it failed unbilled). */
  settle(usedTokens: number): Promise<void>;
}

/**
 * Reserves `estimate` tokens of the business's monthly budget before a model call, atomically,
 * so concurrent turns can never spend past the hard limit by more than one call's estimate
 * error. `null`: the budget is used up (the AI pauses; nothing else does). A reservation that is
 * never settled (a crash) counts in full, so the error is always on the safe side.
 */
export async function reserveLlmTokens(
  db: Database,
  tenantId: TenantId,
  input: { estimate: number; limits: LlmTokenLimits },
  clock: Clock,
): Promise<LlmTokenReservation | null> {
  const id = TenantIdSchema.parse(tenantId);
  const period = usagePeriodOf(clock.now());
  const estimate = Math.max(1, Math.ceil(input.estimate));
  const after = await withTenant(db, id, (tx) =>
    reserveUsage(tx, { metric: 'llm_tokens', period, amount: estimate, limit: input.limits.hard }),
  );
  if (after === null) return null;
  let settled = false;
  return {
    state: llmBudgetStateOf(after, input.limits) === 'ok' ? 'ok' : 'soft',
    async settle(usedTokens) {
      if (settled) return;
      settled = true;
      const delta = Math.max(0, Math.ceil(usedTokens)) - estimate;
      await withTenant(db, id, (tx) => settleUsage(tx, { metric: 'llm_tokens', period, delta }));
    },
  };
}

/** The business's budget state now, without reserving (for a turn's first check and screens). */
export async function llmBudgetState(
  db: Database,
  tenantId: TenantId,
  limits: LlmTokenLimits,
  clock: Clock,
): Promise<LlmBudgetState> {
  const totals = await usageFor(db, tenantId, usagePeriodOf(clock.now()));
  return llmBudgetStateOf(totals.llm_tokens, limits);
}
