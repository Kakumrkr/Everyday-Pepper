import type { LlmUsage } from '@pepper/contracts';

/** A tool call as the eval saw it: `arguments` parsed, or `null` when the JSON was invalid. */
export interface TranscriptToolCall {
  name: string;
  arguments: unknown;
  raw: string;
  /**
   * `arguments` with the seeded world's ids put back as placeholders (`{{booking:maria}}`), so
   * a case can say which record a call must name; absent: match on `arguments`.
   */
  placeheld?: unknown;
}

/** What one run of a case produced, for grading and the report. */
export interface Transcript {
  toolCalls: TranscriptToolCall[];
  replies: string[];
  /** The tools whose actions the run left done (receipts) or proposed, from the database. */
  actions: { done: string[]; proposed: string[] };
  usage: LlmUsage;
  models: string[];
  /**
   * The model calls that failed (`code: message`; the message never holds prompt text). The
   * loop answers the member with a fallback, so the run fails here with the real reason.
   */
  modelErrors?: string[];
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
