import { DRAFT_LIMITS, IMPORT_SUGGESTION_LIMITS, type LlmUsage } from '@pepper/contracts';
import { z } from 'zod';
import { agentTools, instructionsFor } from '../agent/context.js';
import { DEFAULT_LIMITS } from '../agent/loop.js';
import type { EvalCase } from './case.js';
import { evalBusinessContext } from './subject.js';

/** USD per million tokens for one model, from the provider's pricing page (re-checked at S27). */
export const ModelPriceSchema = z.strictObject({
  inputPerMillionUsd: z.number().min(0).max(1_000),
  cachedInputPerMillionUsd: z.number().min(0).max(1_000),
  /** What a token written to the prompt cache costs instead of input (GPT-5.6 and later). */
  cacheWritePerMillionUsd: z.number().min(0).max(1_000).optional(),
  outputPerMillionUsd: z.number().min(0).max(1_000),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PriceTableSchema = z.strictObject({
  checkedOn: z.iso.date().nullable(),
  source: z.string(),
  models: z.record(z.string(), ModelPriceSchema),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** The largest estimate a real run may start with unless told otherwise (playbook §4). */
export const DEFAULT_RUN_CAP_USD = 1.5;
/** No single run may plan to spend more than the whole Phase 6 budget's working part. */
export const MAX_RUN_CAP_USD = 4.5;
/**
 * The most cases one real run may hold: sets run in chunks (S26b's worst case, ~$0.05 a case;
 * S30's seventeen tools and memory instructions ~$0.06, so 20; S37's twenty-one ~$0.077, so 18;
 * S56a's twenty-three ~$0.084, so 17).
 */
export const MAX_CASES_PER_RUN = 17;
/** Output tokens assumed per call when estimating. Generous on purpose. */
export const OUTPUT_ALLOWANCE_TOKENS = 600;
/** Characters per token when estimating input: low, so the estimate errs high. */
const CHARS_PER_TOKEN = 3;

const tokensOf = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** A written token is billed at the write rate instead of the input rate, not on top of it. */
export function costOfUsage(usage: LlmUsage, price: ModelPrice): number {
  const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens - written);
  return (
    (uncached * price.inputPerMillionUsd +
      usage.cachedInputTokens * price.cachedInputPerMillionUsd +
      written * (price.cacheWritePerMillionUsd ?? price.inputPerMillionUsd) +
      usage.outputTokens * price.outputPerMillionUsd) /
    1_000_000
  );
}

/** Drafts one eval morning pass may write (the feed world has one or two regulars due). */
export const DRAFTS_PER_PASS_ESTIMATE = 3;

/**
 * The most a run of `cases`, `trials` times each, should cost: every turn taking the loop's
 * every step (`callsPerTurn`), every call's input counted in full, uncached and at the write
 * rate when that is dearer (instructions,
 * tools, the conversation so far with an allowance for each earlier answer or tool result)
 * and the full output allowance per call.
 */
export function estimateRunCost(
  cases: readonly EvalCase[],
  trials: number,
  price: ModelPrice,
  callsPerTurn: number = DEFAULT_LIMITS.maxSteps,
): { usd: number; usage: LlmUsage } {
  let inputTokens = 0;
  let outputTokens = 0;
  const tools = tokensOf(JSON.stringify(agentTools()));
  for (const evalCase of cases) {
    // Seeded facts may all come along (the business's in the instructions, the rest with records).
    const remembered = evalCase.seed.facts.reduce(
      (sum, fact) => sum + tokensOf(fact.value) + 30,
      0,
    );
    const base =
      tokensOf(instructionsFor(evalBusinessContext(evalCase), new Date(evalCase.now))) +
      tools +
      remembered;
    let conversation = 0;
    for (const turn of evalCase.turns) {
      // A morning drafts pass (S36): up to `DRAFTS_PER_PASS_ESTIMATE` single calls, each at most
      // a draft's whole allowance in and out.
      if (!('user' in turn) && 'morningDrafts' in turn.action) {
        inputTokens += DRAFTS_PER_PASS_ESTIMATE * DRAFT_LIMITS.maxTokens;
        outputTokens += DRAFTS_PER_PASS_ESTIMATE * DRAFT_LIMITS.maxOutputTokens;
        continue;
      }
      // An imported file (S56a.2): one suggester call at most, its whole allowance in and out.
      if (!('user' in turn) && 'importFile' in turn.action) {
        inputTokens += IMPORT_SUGGESTION_LIMITS.maxTokens;
        outputTokens += IMPORT_SUGGESTION_LIMITS.maxOutputTokens;
        continue;
      }
      if (!('user' in turn)) continue;
      conversation += tokensOf(turn.user);
      // Every step of the loop sends the turn so far again (a tool result per step, at most).
      for (let call = 0; call < callsPerTurn; call += 1) {
        inputTokens += base + conversation;
        outputTokens += OUTPUT_ALLOWANCE_TOKENS;
        conversation += OUTPUT_ALLOWANCE_TOKENS;
      }
    }
  }
  const usage = {
    inputTokens: inputTokens * trials,
    cachedInputTokens: 0,
    outputTokens: outputTokens * trials,
  };
  // Every input token at the dearer of the input and cache-write rates.
  const worst = {
    ...price,
    inputPerMillionUsd: Math.max(price.inputPerMillionUsd, price.cacheWritePerMillionUsd ?? 0),
  };
  return { usd: costOfUsage(usage, worst), usage };
}

/** Why a real run may not start, or `null` when it may (the budget guard, ADR-0027). */
export function refuseRun(options: {
  model: string;
  prices: PriceTable;
  estimateUsd: number;
  capUsd: number;
}): string | null {
  // A cap that is not a positive number (a typo on the command line) must never mean "no cap".
  if (!Number.isFinite(options.capUsd) || options.capUsd <= 0 || options.capUsd > MAX_RUN_CAP_USD) {
    return `The cap must be a number of dollars above 0 and at most ${MAX_RUN_CAP_USD.toFixed(2)}.`;
  }
  if (!Number.isFinite(options.estimateUsd)) return 'The run could not be estimated.';
  if (options.prices.models[options.model] === undefined) {
    return `No price for ${options.model} in evals/prices.json: add it from the provider's pricing page first.`;
  }
  if (options.estimateUsd > options.capUsd) {
    return `Estimated $${options.estimateUsd.toFixed(2)} is over the $${options.capUsd.toFixed(2)} cap for one run.`;
  }
  return null;
}

/**
 * The cases a run takes: those of the given sets and ids (none given: all), then, with
 * `chunk`, the chunk-th slice of `chunkSize` (default and at most `MAX_CASES_PER_RUN`) in order. Unknown ids are an error, so a
 * typo never silently runs nothing.
 */
export function selectCases(
  cases: readonly EvalCase[],
  options: {
    sets: readonly string[];
    ids: readonly string[];
    chunk: number | null;
    chunkSize?: number;
  },
): EvalCase[] {
  const unknown = options.ids.filter((id) => !cases.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) throw new Error(`No eval case ${unknown.join(', ')}`);
  const chosen = cases.filter(
    (evalCase) =>
      (options.sets.length === 0 || options.sets.includes(evalCase.set)) &&
      (options.ids.length === 0 || options.ids.includes(evalCase.id)),
  );
  if (options.chunk === null) return chosen;
  if (!Number.isInteger(options.chunk) || options.chunk < 1) {
    throw new Error('--chunk is a whole number from 1');
  }
  const size = options.chunkSize ?? MAX_CASES_PER_RUN;
  if (!Number.isInteger(size) || size < 1 || size > MAX_CASES_PER_RUN) {
    throw new Error(`--chunk-size is a whole number from 1 to ${String(MAX_CASES_PER_RUN)}`);
  }
  return chosen.slice((options.chunk - 1) * size, options.chunk * size);
}
