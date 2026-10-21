import type { LlmUsage } from '@pepper/contracts';

/** A tool call as the eval saw it: `arguments` parsed, or `null` when the JSON was invalid. */
export interface TranscriptToolCall {
  name: string;
  arguments: unknown;
  raw: string;
}

/** What one run of a case produced, for grading and the report. */
export interface Transcript {
  toolCalls: TranscriptToolCall[];
  replies: string[];
  /** The tools whose actions the run left done (receipts) or proposed, from the database. */
  actions: { done: string[]; proposed: string[] };
  usage: LlmUsage;
  models: string[];
}

export const emptyUsage = (): LlmUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
});

export function addUsage(total: LlmUsage, usage: LlmUsage): LlmUsage {
  return {
    inputTokens: total.inputTokens + usage.inputTokens,
    cachedInputTokens: total.cachedInputTokens + usage.cachedInputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
  };
}
