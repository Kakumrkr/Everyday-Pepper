// Test-only (not built into dist): a stand-in for OpenAI's HTTP API that answers with bodies
// shaped like the Responses API's documented objects and events, and records every request.
// No test reaches the real API (ADR-0027, the $5 budget policy).

export interface FakeOpenAiRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type FakeOpenAiAnswer =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'sse'; events: unknown[] }
  | { kind: 'hang' }
  | { kind: 'network_error' };

const USAGE = (input: number, cached: number, output: number, written = 0) => ({
  input_tokens: input,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: written },
  output_tokens: output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: input + output,
});

/** A Responses API `Response` object with the given output items. */
export function openAiResponse(
  output: unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'resp_test',
    object: 'response',
    created_at: 1_760_000_000,
    status: 'completed',
    model: 'model-routine-2026',
    output,
    output_text: '',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    usage: USAGE(12, 4, 3),
    ...overrides,
  };
}

export const outputMessage = (text: string, phase?: string) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
  ...(phase !== undefined && { phase }),
});

export const outputRefusal = (refusal: string) => ({
  id: 'msg_refusal',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'refusal', refusal }],
});

export const outputFunctionCall = (callId: string, name: string, args: string) => ({
  id: `fc_${callId}`,
  type: 'function_call',
  status: 'completed',
  call_id: callId,
  name,
  arguments: args,
});

export const outputReasoning = (id: string, encrypted: string) => ({
  id,
  type: 'reasoning',
  summary: [],
  encrypted_content: encrypted,
});

export const usage = USAGE;

/** The events OpenAI streams for `response`: created, text deltas, then completed. */
export function streamEvents(response: Record<string, unknown>, deltas: string[]): unknown[] {
  let sequence = 0;
  const next = () => (sequence += 1);
  return [
    {
      type: 'response.created',
      sequence_number: next(),
      response: { ...response, status: 'in_progress', output: [] },
    },
    ...deltas.map((delta) => ({
      type: 'response.output_text.delta',
      sequence_number: next(),
      item_id: 'msg_test',
      output_index: 0,
      content_index: 0,
      delta,
      logprobs: [],
    })),
    {
      type: response['status'] === 'incomplete' ? 'response.incomplete' : 'response.completed',
      sequence_number: next(),
      response,
    },
  ];
}

/**
 * A `fetch` that answers each call with the next answer (the last one repeats) and records the
 * requests. `hang` waits until the SDK aborts (its timeout or the caller's signal).
 */
export function fakeOpenAiFetch(answers: FakeOpenAiAnswer[]): {
  fetch: typeof globalThis.fetch;
  requests: FakeOpenAiRequest[];
} {
  const requests: FakeOpenAiRequest[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    requests.push({
      url,
      headers: new Headers(init?.headers),
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    const signal = init?.signal ?? undefined;
    if (answer === undefined) return Promise.reject(new Error('fakeOpenAiFetch: no answer'));
    switch (answer.kind) {
      case 'json':
        return Promise.resolve(
          new Response(JSON.stringify(answer.body), {
            status: answer.status ?? 200,
            headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
          }),
        );
      case 'sse': {
        const text = answer.events
          .map((event) => {
            const type = (event as { type?: unknown }).type;
            return `event: ${String(type)}\ndata: ${JSON.stringify(event)}\n\n`;
          })
          .join('');
        return Promise.resolve(
          new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
        );
      }
      case 'network_error':
        return Promise.reject(new TypeError('fetch failed'));
      case 'hang':
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          };
          if (signal?.aborted === true) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
    }
  };
  return { fetch, requests };
}

/** An OpenAI error body, as the API sends it. */
export const errorBody = (message: string, code: string | null = null, type = 'error') => ({
  error: { message, type, param: null, code },
});
