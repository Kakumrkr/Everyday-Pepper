import type { LlmRequest, LlmResponse, LlmStreamEvent, LlmUsage } from '@pepper/contracts';
import { z } from 'zod';
import { isLlmError } from '../errors.js';
import type { Embedder } from '../embedder.js';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import { costOfUsage, type ModelPrice, type PriceTable } from './cost.js';

// The OpenAI budget ledger (playbook §4, S27): every real run appends one entry with the
// tokens each model actually used and what they cost, whether the run finished, was stopped
// or failed (a failed call can still be billed). `packages/ai/evals/ledger.json` is the
// source; `docs/plan/ai-budget.md` shows it. Before a run the CLI refuses an estimate that
// would take the total past $4.50; during a run `guardedProvider` refuses the next call once
// the run reaches its cap or the total its stop, so even a wrong estimate cannot overspend.

/** The whole Phase 6 budget ($5) minus a reserve the runner never touches. */
export const CUMULATIVE_STOP_USD = 4.5;
export const BUDGET_USD = 5;

/**
 * Each later phase's share of what is left (Phase 7 playbook §4, S28): a real run names its
 * phase, its ledger label starts with `P<phase> `, and the runner refuses a run (and stops the
 * next call) that would take the phase past its cap.
 */
// Phase 7: $1.00, raised at S33 (user) for the full re-record and pass^3: $1.40 at the brief,
// then $1.55 once one whole-suite run was measured at about $0.20. Phase 8 (S34, playbook D-13):
// $1.25 of the $2.99 left, about $1.10 of it planned; raised to $1.75 at the S38a brief (user:
// "Go with your recommendations") for S38b's full re-record and pass^3, planned about $0.75;
// raised to $2.00 in S38b (user: "Fix, cap $2.00") for the waitlist guide fix's second re-record.
export const PHASE_CAPS_USD: Readonly<Record<number, number>> = { 7: 1.55, 8: 2 };

/** The ledger label of a run for `phase`: `P7 <label>`. */
export function phaseLabel(phase: number, label: string): string {
  return `P${String(phase)} ${label}`;
}

/** What the runs labelled for `phase` spent. */
export function phaseSpentUsd(ledger: Ledger, phase: number): number {
  const prefix = phaseLabel(phase, '');
  return ledger.entries
    .filter((entry) => entry.label.startsWith(prefix))
    .reduce((total, entry) => total + entry.actualUsd, 0);
}

/** Why a run for `phase` may not start, or `null` when it may. */
export function refusePhase(options: {
  phase: number;
  spentUsd: number;
  estimateUsd: number;
  /**
   * `--phase-estimate-ok` (user, S31): run although the worst-case estimate would pass the
   * cap, as long as the phase has not reached it. The estimate runs 100–300× above actual
   * spend, so a multi-turn case near the end of a phase could never be recorded; the in-run
   * stop still refuses every call once actual spend reaches the cap.
   */
  estimateOk?: boolean;
}): string | null {
  const cap = PHASE_CAPS_USD[options.phase];
  if (cap === undefined) return `Phase ${String(options.phase)} has no OpenAI budget.`;
  const total = options.spentUsd + options.estimateUsd;
  if (options.spentUsd >= cap || (total > cap && options.estimateOk !== true)) {
    return `Phase ${String(options.phase)} spent ${usd(options.spentUsd)}; this run could take it to ${usd(total)}, past its ${usd(cap)} cap.`;
  }
  return null;
}

const UsdSchema = z.number().min(0).max(100);

export const ModelSpendSchema = z.strictObject({
  calls: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  usd: UsdSchema,
  /** Whole-answer time of the calls, in milliseconds (`null` when none finished). */
  latencyMsP50: z.number().min(0).nullable(),
  latencyMsP95: z.number().min(0).nullable(),
});
export type ModelSpend = z.infer<typeof ModelSpendSchema>;

export const LedgerEntrySchema = z.strictObject({
  id: z.number().int().min(1),
  at: z.iso.datetime(),
  /** What the run was for: "smoke", "pass^1 scheduling 1/3", "safety pass^3"… */
  label: z.string().min(1).max(200),
  status: z.enum(['completed', 'stopped', 'failed']),
  cases: z.number().int().min(0),
  trials: z.number().int().min(1),
  estimateUsd: UsdSchema,
  actualUsd: UsdSchema,
  byModel: z.record(z.string(), ModelSpendSchema),
  /** Characters sent per input token the provider counted (calibrates the estimate). */
  charsPerToken: z.number().positive().nullable(),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const LedgerSchema = z
  .strictObject({
    version: z.literal(1),
    budgetUsd: z.literal(BUDGET_USD),
    entries: z.array(LedgerEntrySchema),
  })
  .refine((ledger) => ledger.entries.every((entry, index) => entry.id === index + 1), {
    message: 'Ledger entries are numbered 1, 2, 3… and only ever appended',
  });
export type Ledger = z.infer<typeof LedgerSchema>;

export const emptyLedger = (): Ledger => ({ version: 1, budgetUsd: BUDGET_USD, entries: [] });

export function spentUsd(ledger: Ledger): number {
  return ledger.entries.reduce((total, entry) => total + entry.actualUsd, 0);
}

const usd = (amount: number, digits = 2) => `$${amount.toFixed(digits)}`;

/** Why a run may not start given what was spent before, or `null` when it may. */
export function refuseCumulative(options: {
  spentUsd: number;
  estimateUsd: number;
  /**
   * `--phase-estimate-ok` (S38b, user): the worst-case estimate may pass the stop too, as it may
   * the phase cap; the in-run stop still refuses every call once actual spend reaches it.
   */
  estimateOk?: boolean;
}): string | null {
  const total = options.spentUsd + options.estimateUsd;
  if (
    options.spentUsd >= CUMULATIVE_STOP_USD ||
    (total > CUMULATIVE_STOP_USD && options.estimateOk !== true)
  ) {
    return `Spent ${usd(options.spentUsd)} so far; this run could take the total to ${usd(total)}, past the ${usd(CUMULATIVE_STOP_USD)} stop.`;
  }
  return null;
}

/**
 * The price of the model that answered: its own, or the alias it is a dated snapshot of
 * (`model-mini-2026-08-01` → `model-mini`); an unknown model is priced as the dearest one.
 */
export function priceOf(prices: PriceTable, model: string): ModelPrice {
  const exact = prices.models[model];
  if (exact !== undefined) return exact;
  const alias = Object.entries(prices.models)
    .filter(([name]) => model.startsWith(`${name}-`))
    .sort(([a], [b]) => b.length - a.length)[0];
  if (alias !== undefined) return alias[1];
  const dearest = Object.values(prices.models).sort(
    (a, b) =>
      b.inputPerMillionUsd + b.outputPerMillionUsd - (a.inputPerMillionUsd + a.outputPerMillionUsd),
  )[0];
  if (dearest === undefined) throw new Error('The price table is empty');
  return dearest;
}

/** A thrown stop: not the provider's failure, so the eval run ends instead of falling back. */
export class BudgetStopError extends Error {
  override readonly name = 'BudgetStopError';
}

const percentile = (values: readonly number[], p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
};

/** What a run spent so far, by the model that answered (`unknown` for a failed billed call). */
export class SpendTracker {
  runUsd = 0;
  private readonly models = new Map<
    string,
    { usage: LlmUsage & { cacheWriteTokens: number }; calls: number; usd: number; ms: number[] }
  >();
  private charsSent = 0;
  private tokensCounted = 0;

  constructor(
    private readonly options: {
      prices: PriceTable;
      spentBeforeUsd: number;
      capUsd: number;
      /** The run's phase: what it spent before and its cap. */
      phase?: { spentBeforeUsd: number; capUsd: number };
    },
  ) {}

  /** Why the next call may not go out, or `null`. */
  stopReason(): string | null {
    if (this.runUsd >= this.options.capUsd) {
      return `Spent ${usd(this.runUsd, 4)}, this run's ${usd(this.options.capUsd)} cap.`;
    }
    const phase = this.options.phase;
    if (phase !== undefined && phase.spentBeforeUsd + this.runUsd >= phase.capUsd) {
      return `The phase reached its ${usd(phase.capUsd)} cap.`;
    }
    if (this.options.spentBeforeUsd + this.runUsd >= CUMULATIVE_STOP_USD) {
      return `The total reached the ${usd(CUMULATIVE_STOP_USD)} stop.`;
    }
    return null;
  }

  /** `request`: the chat request answered (`null`: an embedding, not in the chars a token). */
  add(model: string, usage: LlmUsage, request: LlmRequest | null, ms: number | null): void {
    const cost = costOfUsage(usage, priceOf(this.options.prices, model));
    this.runUsd += cost;
    const spend = this.models.get(model) ?? {
      usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      calls: 0,
      usd: 0,
      ms: [],
    };
    spend.calls += 1;
    spend.usd += cost;
    spend.usage = {
      inputTokens: spend.usage.inputTokens + usage.inputTokens,
      cachedInputTokens: spend.usage.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteTokens: spend.usage.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      outputTokens: spend.usage.outputTokens + usage.outputTokens,
    };
    if (ms !== null) spend.ms.push(ms);
    this.models.set(model, spend);
    if (usage.inputTokens > 0 && request !== null) {
      this.charsSent += requestChars(request);
      this.tokensCounted += usage.inputTokens;
    }
  }

  byModel(): Record<string, ModelSpend> {
    return Object.fromEntries(
      [...this.models].map(([model, spend]) => [
        model,
        {
          calls: spend.calls,
          ...spend.usage,
          usd: spend.usd,
          latencyMsP50: percentile(spend.ms, 50),
          latencyMsP95: percentile(spend.ms, 95),
        },
      ]),
    );
  }

  /** Characters per input token over the run (the estimate assumes 3), or `null`. */
  charsPerToken(): number | null {
    return this.tokensCounted === 0 ? null : this.charsSent / this.tokensCounted;
  }
}

/** The characters a request sends as input, the way the estimate counts them. */
function requestChars(request: LlmRequest): number {
  return (
    request.instructions.length +
    JSON.stringify(request.tools).length +
    JSON.stringify(request.messages).length
  );
}

/**
 * Counts what every answer cost (and every failed call the provider says it billed) and
 * refuses the next call once the run's cap or the total's stop is reached.
 */
export function guardedProvider(provider: LlmProvider, tracker: SpendTracker): LlmProvider {
  const check = () => {
    const reason = tracker.stopReason();
    if (reason !== null) throw new BudgetStopError(reason);
  };
  const failed = (request: LlmRequest, error: unknown): never => {
    if (isLlmError(error) && error.usage !== undefined) {
      tracker.add('unknown', error.usage, request, null);
    }
    throw error;
  };
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse> {
      check();
      const started = performance.now();
      const response = await provider
        .respond(request, options)
        .catch((e: unknown) => failed(request, e));
      tracker.add(response.model, response.usage, request, performance.now() - started);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
      check();
      const started = performance.now();
      try {
        for await (const event of provider.stream(request, options)) {
          if (event.type === 'done') {
            tracker.add(
              event.response.model,
              event.response.usage,
              request,
              performance.now() - started,
            );
          }
          yield event;
        }
      } catch (error) {
        failed(request, error);
      }
    },
  };
}

/** `guardedProvider` for the embedding model (S31): counted, and refused past the caps. */
export function guardedEmbedder(embedder: Embedder, tracker: SpendTracker): Embedder {
  return {
    model: embedder.model,
    async embed(request, options) {
      const reason = tracker.stopReason();
      if (reason !== null) throw new BudgetStopError(reason);
      const started = performance.now();
      const response = await embedder.embed(request, options).catch((error: unknown) => {
        if (isLlmError(error) && error.usage !== undefined) {
          tracker.add(embedder.model, error.usage, null, null);
        }
        throw error;
      });
      tracker.add(response.model, response.usage, null, performance.now() - started);
      return response;
    },
  };
}

/** `docs/plan/ai-budget.md`: the ledger as a table, with the total against the budget. */
export function budgetMarkdown(ledger: Ledger): string {
  const total = spentUsd(ledger);
  let running = 0;
  const rows = ledger.entries.map((entry) => {
    running += entry.actualUsd;
    return `| ${String(entry.id)} | ${entry.at.slice(0, 10)} | ${entry.label} | ${entry.status} | ${String(entry.cases)} × ${String(entry.trials)} | ${usd(entry.estimateUsd)} | ${usd(entry.actualUsd, 4)} | ${usd(running, 4)} |`;
  });
  const details = ledger.entries.flatMap((entry) =>
    Object.entries(entry.byModel).map(
      ([model, spend]) =>
        `- Run ${String(entry.id)}, ${model}: ${String(spend.calls)} calls, ${String(spend.inputTokens)} in (${String(spend.cachedInputTokens)} cached, ${String(spend.cacheWriteTokens)} written), ${String(spend.outputTokens)} out, p50 ${spend.latencyMsP50 === null ? '–' : String(Math.round(spend.latencyMsP50))} ms, p95 ${spend.latencyMsP95 === null ? '–' : String(Math.round(spend.latencyMsP95))} ms${entry.charsPerToken === null ? '' : `; ${entry.charsPerToken.toFixed(2)} chars a token`}`,
    ),
  );
  return [
    `Total spent: **${usd(total, 4)}** of ${usd(ledger.budgetUsd)} (the runner stops at ${usd(CUMULATIVE_STOP_USD)}).`,
    '',
    '| Run | Date | What | Status | Cases × trials | Estimate | Actual | Total so far |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    ...(details.length > 0 ? ['', ...details] : []),
  ].join('\n');
}
