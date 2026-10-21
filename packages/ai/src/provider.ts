import type { LlmRequest, LlmResponse, LlmStreamEvent } from '@pepper/contracts';

export interface LlmCallOptions {
  /** Cancels the call (the user left, or the turn's time budget ran out): `aborted`. */
  signal?: AbortSignal;
}

/**
 * The one way Pepper talks to a language model (ADR-0004, ADR-0027). Implementations map the
 * provider-neutral request to their API and every failure to an `LlmError`; their own types
 * never leave them. Fakes implement it too and pass the same contract suite.
 */
export interface LlmProvider {
  /** One complete answer. */
  respond(request: LlmRequest, options?: LlmCallOptions): Promise<LlmResponse>;
  /** The same answer streamed: text as it arrives, then exactly one `done`. */
  stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent>;
}
