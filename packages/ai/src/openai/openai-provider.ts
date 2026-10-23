import {
  LlmResponseSchema,
  type LlmMessage,
  type LlmReplay,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
  type LlmToolCall,
  type LlmUsage,
} from '@pepper/contracts';
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from 'openai';
import type {
  Response as OpenAiResponse,
  ResponseCreateParamsNonStreaming,
  ResponseInputItem,
  ResponseUsage,
} from 'openai/resources/responses/responses';
import { LlmError, isLlmError } from '../errors.js';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import type { OpenAiConfig } from './config.js';

/** The replay item that carries an assistant message's `phase` (ADR-0027). */
const PHASE_ITEM = 'pepper.message_phase';

export interface OpenAiProviderOptions extends OpenAiConfig {
  /** Replaces the network (tests answer with fixtures shaped like OpenAI's documented API). */
  fetch?: typeof globalThis.fetch;
}

/**
 * `LlmProvider` on OpenAI's Responses API (ADR-0027) with the official SDK. Every request
 * sends `store: false`, so OpenAI keeps no conversation state; reasoning items come back
 * encrypted in `replay` and go out again with the next request. Retries are the caller's:
 * the SDK's own are off, so the agent loop decides with its time budget in view.
 */
export class OpenAiProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAiProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined && { baseURL: options.baseUrl }),
      timeout: options.timeoutMs,
      maxRetries: 0,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
  }

  async respond(request: LlmRequest, options: LlmCallOptions = {}): Promise<LlmResponse> {
    try {
      const response = await this.client.responses.create(this.params(request), {
        ...(options.signal !== undefined && { signal: options.signal }),
      });
      return toLlmResponse(response);
    } catch (error) {
      throw toLlmError(error);
    }
  }

  async *stream(request: LlmRequest, options: LlmCallOptions = {}): AsyncIterable<LlmStreamEvent> {
    try {
      const events = await this.client.responses.create(
        { ...this.params(request), stream: true },
        { ...(options.signal !== undefined && { signal: options.signal }) },
      );
      for await (const event of events) {
        // Only these events matter; the many others (item and part boundaries) are skipped.
        if (event.type === 'response.output_text.delta') {
          yield { type: 'text_delta', delta: event.delta };
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          yield { type: 'done', response: toLlmResponse(event.response) };
          return;
        } else if (event.type === 'response.failed') {
          throw failedError(event.response);
        } else if (event.type === 'error') {
          throw new LlmError('unavailable', 'OpenAI reported an error in the stream');
        }
      }
      throw new LlmError('invalid_response', 'The stream ended without a response');
    } catch (error) {
      throw toLlmError(error);
    }
  }

  private params(request: LlmRequest): ResponseCreateParamsNonStreaming {
    const effort = this.options.reasoning?.[request.route];
    return {
      model: this.options.models[request.route],
      ...(effort !== undefined && { reasoning: { effort } }),
      instructions: request.instructions,
      input: request.messages.flatMap(toInputItems),
      tools: request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: true,
      })),
      tool_choice: request.toolChoice,
      parallel_tool_calls: true,
      max_output_tokens: request.maxOutputTokens,
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(request.cacheKey !== undefined && { prompt_cache_key: request.cacheKey }),
      ...(request.safetyId !== undefined && { safety_identifier: request.safetyId }),
    };
  }
}

function toInputItems(message: LlmMessage): ResponseInputItem[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.content }];
    case 'tool':
      return [
        { type: 'function_call_output', call_id: message.toolCallId, output: message.content },
      ];
    case 'assistant': {
      const phase = message.replay.find((item) => item['type'] === PHASE_ITEM)?.['phase'];
      // Reasoning items first, as the model produced them, then the text and the tool calls.
      const reasoning = message.replay.filter(
        (item) => item['type'] !== PHASE_ITEM,
      ) as unknown as ResponseInputItem[];
      const text: ResponseInputItem[] =
        message.content === ''
          ? []
          : [
              {
                role: 'assistant',
                content: message.content,
                ...((phase === 'commentary' || phase === 'final_answer') && { phase }),
              },
            ];
      const calls: ResponseInputItem[] = message.toolCalls.map((call) => ({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      }));
      return [...reasoning, ...text, ...calls];
    }
  }
}

function toUsage(usage: ResponseUsage | null | undefined): LlmUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  // Older models may leave the write count out; it is only billed on GPT-5.6 and later.
  const written = usage.input_tokens_details.cache_write_tokens as number | undefined;
  return {
    inputTokens: usage.input_tokens,
    cachedInputTokens: usage.input_tokens_details.cached_tokens,
    ...(written !== undefined && written > 0 && { cacheWriteTokens: written }),
    outputTokens: usage.output_tokens,
  };
}

function failedError(response: OpenAiResponse): LlmError {
  return new LlmError(
    'unavailable',
    'OpenAI could not finish the response',
    toUsage(response.usage),
  );
}

/** Maps a finished Responses API answer; anything unexpected is `invalid_response`. */
export function toLlmResponse(response: OpenAiResponse): LlmResponse {
  if (response.status === 'failed') throw failedError(response);
  if (response.status !== 'completed' && response.status !== 'incomplete') {
    throw new LlmError('invalid_response', 'OpenAI returned an unfinished response');
  }
  const usage = toUsage(response.usage);
  if (usage === undefined) throw new LlmError('invalid_response', 'OpenAI returned no usage');

  let text = '';
  let refusal: string | undefined;
  const toolCalls: LlmToolCall[] = [];
  const replay: LlmReplay = [];
  for (const item of response.output) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'output_text') text += part.text;
        else refusal = (refusal ?? '') + part.refusal;
      }
      if (item.phase === 'commentary' || item.phase === 'final_answer') {
        replay.push({ type: PHASE_ITEM, phase: item.phase });
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
    } else if (item.type === 'reasoning') {
      replay.push({ ...item });
    } else {
      // Only function tools are offered, so any other item means the API changed under us.
      throw new LlmError('invalid_response', `OpenAI returned an unexpected ${item.type} item`);
    }
  }

  const reason = response.incomplete_details?.reason;
  const finishReason =
    response.status === 'incomplete'
      ? reason === 'content_filter'
        ? 'content_filter'
        : 'length'
      : refusal !== undefined
        ? 'refused'
        : toolCalls.length > 0
          ? 'tool_calls'
          : 'stop';

  const parsed = LlmResponseSchema.safeParse({
    text,
    toolCalls,
    replay,
    finishReason,
    ...(refusal !== undefined && { refusal }),
    usage,
    model: response.model,
  });
  if (!parsed.success) throw new LlmError('invalid_response', 'OpenAI returned an invalid answer');
  return parsed.data;
}

/** Maps anything the SDK throws to an `LlmError`, without the provider's message text. */
export function toLlmError(error: unknown): LlmError {
  if (isLlmError(error)) return error;
  if (error instanceof APIUserAbortError) return new LlmError('aborted', 'The call was cancelled');
  if (error instanceof APIConnectionTimeoutError) {
    return new LlmError('timeout', 'OpenAI did not answer in time');
  }
  if (error instanceof APIConnectionError) {
    return new LlmError('unavailable', 'OpenAI could not be reached');
  }
  if (error instanceof APIError) {
    const status: unknown = error.status;
    // No status: the SDK read an `error` event inside a stream, a failure on OpenAI's side.
    if (typeof status !== 'number') {
      return new LlmError('unavailable', 'OpenAI reported an error in the stream');
    }
    const label = `OpenAI answered ${String(status)}`;
    if (status === 429) {
      return error.code === 'insufficient_quota'
        ? new LlmError('budget_exceeded', `${label}: the account's quota is used up`)
        : new LlmError('rate_limited', label);
    }
    if (status === 408) return new LlmError('timeout', label);
    if (status === 401 || status === 403) return new LlmError('auth', label);
    if (status >= 500) return new LlmError('unavailable', label);
    return new LlmError('bad_request', label);
  }
  return new LlmError('invalid_response', 'OpenAI returned something unexpected');
}
