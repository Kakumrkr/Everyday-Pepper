import {
  LlmRequestSchema,
  LlmResponseSchema,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type LlmToolCall,
} from '@pepper/contracts';
import { LlmError } from './errors.js';
import type { LlmCallOptions, LlmProvider } from './provider.js';

/** One scripted answer: a response, an error to throw, or a function of the request. */
export type ScriptStep =
  | LlmResponse
  | LlmError
  | ((request: LlmRequest, options: LlmCallOptions) => LlmResponse | Promise<LlmResponse>);

/** A response for scripts: text and tool calls, with neutral defaults for the rest. */
export function scriptedResponse(
  answer: { text?: string; toolCalls?: LlmToolCall[] } & Partial<LlmResponse> = {},
): LlmResponse {
  const toolCalls = answer.toolCalls ?? [];
  return LlmResponseSchema.parse({
    text: '',
    replay: [],
    finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    model: 'scripted',
    ...answer,
    toolCalls,
  });
}

/** Rejects with `aborted` when `signal` fires (for scripts that wait like a slow model). */
export function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      reject(new LlmError('aborted', 'The call was cancelled'));
    };
    if (signal?.aborted === true) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * A provider that answers from a script, one step per call, and records every request (tests,
 * evals on hand-written cassettes, ADR-0027). It validates requests like a real provider would
 * and fails loudly when the script runs out, so a test never passes on an unplanned call.
 */
export class ScriptedProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  private readonly steps: ScriptStep[];

  constructor(steps: readonly ScriptStep[]) {
    this.steps = [...steps];
  }

  /** Steps not used yet. */
  get remaining(): number {
    return this.steps.length;
  }

  async respond(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    const parsed = LlmRequestSchema.safeParse(request);
    if (!parsed.success) throw new LlmError('bad_request', 'The request is not valid');
    if (options.signal?.aborted === true) throw new LlmError('aborted', 'The call was cancelled');
    this.requests.push(parsed.data);
    const step = this.steps.shift();
    if (step === undefined) {
      throw new Error(`ScriptedProvider: no step left for call ${String(this.requests.length)}`);
    }
    if (step instanceof LlmError) throw step;
    const response = typeof step === 'function' ? await step(parsed.data, options) : step;
    return LlmResponseSchema.parse(response);
  }

  async *stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncIterable<LlmStreamEvent> {
    const response = await this.respond(request, options);
    // Word by word, like a provider's deltas: joined they are exactly the text.
    for (const delta of response.text.match(/\S+\s*|\s+/g) ?? []) {
      yield { type: 'text_delta', delta };
    }
    yield { type: 'done', response };
  }
}
