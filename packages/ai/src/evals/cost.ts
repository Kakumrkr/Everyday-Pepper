import type { LlmToolDefinition, LlmUsage } from '@pepper/contracts';
import { z } from 'zod';
import type { EvalCase } from './case.js';
import { skeletonInstructions } from './subject.js';

/** USD per million tokens for one model, from the provider's pricing page (re-checked at S27). */
export const ModelPriceSchema = z.strictObject({
  inputPerMillionUsd: z.number().min(0).max(1_000),
  cachedInputPerMillionUsd: z.number().min(0).max(1_000),
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
/** Output tokens assumed per call when estimating. Generous on purpose. */
export const OUTPUT_ALLOWANCE_TOKENS = 600;
/** Characters per token when estimating input: low, so the estimate errs high. */
const CHARS_PER_TOKEN = 3;

const tokensOf = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);

export function costOfUsage(usage: LlmUsage, price: ModelPrice): number {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncached * price.inputPerMillionUsd +
      usage.cachedInputTokens * price.cachedInputPerMillionUsd +
      usage.outputTokens * price.outputPerMillionUsd) /
    1_000_000
  );
}

/**
 * The most a run of `cases`, `trials` times each, should cost: every call's input counted in
 * full and uncached (instructions, tools, the conversation so far with an allowance for each
 * earlier answer) and the full output allowance per call.
 */
export function estimateRunCost(
  cases: readonly { evalCase: EvalCase; tools: LlmToolDefinition[] }[],
  trials: number,
  price: ModelPrice,
): { usd: number; usage: LlmUsage } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const { evalCase, tools } of cases) {
    const base = tokensOf(skeletonInstructions(evalCase)) + tokensOf(JSON.stringify(tools));
    let conversation = 0;
    for (const turn of evalCase.turns) {
      conversation += tokensOf(turn.user);
      inputTokens += base + conversation;
      outputTokens += OUTPUT_ALLOWANCE_TOKENS;
      conversation += OUTPUT_ALLOWANCE_TOKENS;
    }
  }
  const usage = {
    inputTokens: inputTokens * trials,
    cachedInputTokens: 0,
    outputTokens: outputTokens * trials,
  };
  return { usd: costOfUsage(usage, price), usage };
}

/** Why a real run may not start, or `null` when it may (the budget guard, ADR-0027). */
export function refuseRun(options: {
  model: string;
  prices: PriceTable;
  estimateUsd: number;
  capUsd: number;
}): string | null {
  if (options.prices.models[options.model] === undefined) {
    return `No price for ${options.model} in evals/prices.json: add it from the provider's pricing page first.`;
  }
  if (options.estimateUsd > options.capUsd) {
    return `Estimated $${options.estimateUsd.toFixed(2)} is over the $${options.capUsd.toFixed(2)} cap for one run.`;
  }
  return null;
}
