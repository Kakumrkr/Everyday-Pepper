import type { LlmRequest, LlmStreamEvent } from '@pepper/contracts';
import type { Response as OpenAiResponse } from 'openai/resources/responses/responses';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import {
  CONTRACT_USAGE,
  contractRequest,
  providerContract,
  type ContractScenario,
} from '../provider-contract.js';
import { OpenAiProvider, toLlmError, toLlmResponse } from './openai-provider.js';
import {
  errorBody,
  fakeOpenAiFetch,
  openAiResponse,
  outputFunctionCall,
  outputMessage,
  outputReasoning,
  outputRefusal,
  streamEvents,
  usage,
  type FakeOpenAiAnswer,
} from './test-fixtures.js';

const KEY = 'sk-test-0123456789abcdefghij';
const MODELS = { routine: 'model-routine', strong: 'model-strong' };

function provider(answers: FakeOpenAiAnswer[], timeoutMs = 5_000) {
  const fake = fakeOpenAiFetch(answers);
  return {
    provider: new OpenAiProvider({
      apiKey: KEY,
      models: MODELS,
      timeoutMs,
      baseUrl: 'https://openai.test/v1',
      fetch: fake.fetch,
    }),
    requests: fake.requests,
  };
}

const STATUS = { rate_limited: 429, unavailable: 503, auth: 401, bad_request: 400 } as const;

function answersFor(scenario: ContractScenario): FakeOpenAiAnswer[] {
  const { inputTokens, cachedInputTokens, outputTokens } = CONTRACT_USAGE;
  const tokens = usage(inputTokens, cachedInputTokens, outputTokens);
  switch (scenario.kind) {
    case 'text': {
      // One answer for `respond`, the same as a stream for `stream` (the fake repeats the last).
      const response = openAiResponse([outputMessage(scenario.text)], { usage: tokens });
      return [
        { kind: 'sse', events: streamEvents(response, scenario.text.match(/\S+\s*/g) ?? []) },
      ];
    }
    case 'tool_call':
      return [
        {
          kind: 'json',
          body: openAiResponse(
            [outputFunctionCall(scenario.id, scenario.name, scenario.arguments)],
            {
              usage: tokens,
            },
          ),
        },
      ];
    case 'refusal':
      return [
        {
          kind: 'json',
          body: openAiResponse([outputRefusal(scenario.refusal)], { usage: tokens }),
        },
      ];
    case 'length':
      return [
        {
          kind: 'json',
          body: openAiResponse([outputMessage(scenario.text)], {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: tokens,
          }),
        },
      ];
    case 'error':
      return [
        {
          kind: 'json',
          status: STATUS[scenario.code],
          body: errorBody(`scripted ${scenario.code}`),
        },
      ];
    case 'hang':
      return [{ kind: 'hang' }];
  }
}

// The text scenario streams; `respond` reads the same SSE body as JSON would fail, so answer
// `respond` calls with JSON and `stream` calls with SSE by looking at the request.
function contractProvider(scenario: ContractScenario) {
  const answers = answersFor(scenario);
  const first = answers[0];
  if (scenario.kind !== 'text' || first?.kind !== 'sse') return provider(answers).provider;
  const response = (first.events.at(-1) as { response: unknown }).response;
  const json = fakeOpenAiFetch([{ kind: 'json', body: response }]);
  const sse = fakeOpenAiFetch([first]);
  return new OpenAiProvider({
    apiKey: KEY,
    models: MODELS,
    timeoutMs: 5_000,
    fetch: (input, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        stream?: boolean;
      };
      return body.stream === true ? sse.fetch(input, init) : json.fetch(input, init);
    },
  });
}

providerContract('OpenAiProvider (documented Responses API shapes)', {
  provider: contractProvider,
});

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const all: LlmStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

const conversation: LlmRequest = {
  ...contractRequest,
  route: 'strong',
  cacheKey: 'tenant-cache-key',
  safetyId: 'user-hash',
  toolChoice: 'required',
  messages: [
    { role: 'user', content: 'Book Maria for a haircut.' },
    {
      role: 'assistant',
      content: 'Looking her up.',
      toolCalls: [{ id: 'call_1', name: 'find_clients', arguments: '{"query":"Maria"}' }],
      replay: [
        { type: 'pepper.message_phase', phase: 'commentary' },
        outputReasoning('rs_1', 'ENCRYPTED-1'),
      ],
    },
    { role: 'tool', toolCallId: 'call_1', content: '[{"id":"c1","name":"Maria"}]', isError: false },
  ],
};

describe('OpenAiProvider requests (ADR-0027)', () => {
  it('sends the Responses API request: route model, strict tools, store off, cache and safety ids', async () => {
    const { provider: openai, requests } = provider([
      { kind: 'json', body: openAiResponse([outputMessage('Done.')]) },
    ]);
    await openai.respond(conversation);
    expect(requests).toHaveLength(1);
    const [sent] = requests;
    expect(sent?.url).toBe('https://openai.test/v1/responses');
    expect(sent?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(sent?.body).toEqual({
      model: 'model-strong',
      instructions: contractRequest.instructions,
      input: [
        { role: 'user', content: 'Book Maria for a haircut.' },
        outputReasoning('rs_1', 'ENCRYPTED-1'),
        { role: 'assistant', content: 'Looking her up.', phase: 'commentary' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'find_clients',
          arguments: '{"query":"Maria"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: '[{"id":"c1","name":"Maria"}]' },
      ],
      tools: [
        {
          type: 'function',
          name: 'find_clients',
          description: 'Look clients up by name.',
          parameters: contractRequest.tools[0]?.parameters,
          strict: true,
        },
      ],
      tool_choice: 'required',
      parallel_tool_calls: true,
      max_output_tokens: 400,
      store: false,
      include: ['reasoning.encrypted_content'],
      prompt_cache_key: 'tenant-cache-key',
      safety_identifier: 'user-hash',
    });
  });

  it('uses the routine model, leaves out unset ids, and sends an assistant turn without text as calls only', async () => {
    const { provider: openai, requests } = provider([
      { kind: 'json', body: openAiResponse([outputMessage('ok')]) },
    ]);
    await openai.respond({
      ...contractRequest,
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c', name: 'find_clients', arguments: '{}' }],
          replay: [],
        },
        { role: 'tool', toolCallId: 'c', content: '{"error":"x"}', isError: true },
      ],
    });
    const body = requests[0]?.body ?? {};
    expect(body['model']).toBe('model-routine');
    expect(body).not.toHaveProperty('prompt_cache_key');
    expect(body).not.toHaveProperty('safety_identifier');
    expect(body['input']).toEqual([
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c', name: 'find_clients', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: '{"error":"x"}' },
    ]);
  });
});

describe('OpenAiProvider answers', () => {
  it('keeps reasoning items and the message phase for replay, and joins text parts', async () => {
    const { provider: openai } = provider([
      {
        kind: 'json',
        body: openAiResponse([
          outputReasoning('rs_2', 'ENCRYPTED-2'),
          { ...outputMessage('Two '), phase: 'final_answer' },
          outputMessage('haircuts.'),
          outputFunctionCall('call_9', 'get_day', '{"date":"2026-10-21"}'),
        ]),
      },
    ]);
    const response = await openai.respond(contractRequest);
    expect(response).toMatchObject({
      text: 'Two haircuts.',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'call_9', name: 'get_day', arguments: '{"date":"2026-10-21"}' }],
      replay: [
        outputReasoning('rs_2', 'ENCRYPTED-2'),
        { type: 'pepper.message_phase', phase: 'final_answer' },
      ],
      model: 'model-routine-2026',
    });
  });

  it('maps a content-filter stop', async () => {
    const { provider: openai } = provider([
      {
        kind: 'json',
        body: openAiResponse([], {
          status: 'incomplete',
          incomplete_details: { reason: 'content_filter' },
        }),
      },
    ]);
    expect((await openai.respond(contractRequest)).finishReason).toBe('content_filter');
  });

  it.each([
    [
      'an unexpected item type',
      openAiResponse([{ type: 'web_search_call', id: 'ws', status: 'completed' }]),
    ],
    [
      'a tool name outside our rules',
      openAiResponse([outputFunctionCall('c', 'DropTables', '{}')]),
    ],
    ['an unfinished response', openAiResponse([], { status: 'in_progress' })],
    ['no usage', openAiResponse([outputMessage('hi')], { usage: null })],
  ])('treats %s as invalid_response', async (_label, body) => {
    const { provider: openai } = provider([{ kind: 'json', body }]);
    await expect(openai.respond(contractRequest)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('fails a failed response as unavailable, keeping its usage for metering', async () => {
    const { provider: openai } = provider([
      { kind: 'json', body: openAiResponse([], { status: 'failed', usage: usage(30, 0, 7) }) },
    ]);
    await expect(openai.respond(contractRequest)).rejects.toMatchObject({
      code: 'unavailable',
      usage: { inputTokens: 30, cachedInputTokens: 0, outputTokens: 7 },
    });
  });
});

describe('OpenAiProvider failures', () => {
  it('maps a used-up quota to budget_exceeded (not retryable) and other 429s to rate_limited', async () => {
    const quota = provider([
      { kind: 'json', status: 429, body: errorBody('quota', 'insufficient_quota') },
    ]);
    const error = await quota.provider.respond(contractRequest).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'budget_exceeded', retryable: false });
  });

  it('does not retry on its own: one request per call, even for a 500', async () => {
    const { provider: openai, requests } = provider([
      { kind: 'json', status: 500, body: errorBody('boom') },
    ]);
    await expect(openai.respond(contractRequest)).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toHaveLength(1);
  });

  it('maps 408 and the SDK timeout to timeout, a network failure to unavailable', async () => {
    const slow = provider([{ kind: 'json', status: 408, body: errorBody('slow') }]);
    await expect(slow.provider.respond(contractRequest)).rejects.toMatchObject({ code: 'timeout' });
    const hanging = provider([{ kind: 'hang' }], 1_000);
    await expect(hanging.provider.respond(contractRequest)).rejects.toMatchObject({
      code: 'timeout',
    });
    const offline = provider([{ kind: 'network_error' }]);
    await expect(offline.provider.respond(contractRequest)).rejects.toMatchObject({
      code: 'unavailable',
    });
  }, 15_000);

  it('maps 403 to auth and never puts the key or the provider message in the error', async () => {
    const { provider: openai } = provider([
      { kind: 'json', status: 403, body: errorBody(`Key ${KEY} may not use this model`) },
    ]);
    const error = (await openai
      .respond(contractRequest)
      .catch((caught: unknown) => caught)) as LlmError;
    expect(error.code).toBe('auth');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain('may not use');
  });

  it('maps anything else to invalid_response and passes an LlmError through', () => {
    expect(toLlmError(new Error('weird')).code).toBe('invalid_response');
    const original = new LlmError('aborted', 'x');
    expect(toLlmError(original)).toBe(original);
  });
});

describe('OpenAiProvider streaming', () => {
  it('finishes an incomplete stream with done and its finish reason', async () => {
    const response = openAiResponse([outputMessage('Tomorrow')], {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
    });
    const { provider: openai } = provider([
      { kind: 'sse', events: streamEvents(response, ['Tomorrow']) },
    ]);
    const events = await collect(openai.stream(contractRequest));
    expect(events.at(-1)).toMatchObject({ type: 'done', response: { finishReason: 'length' } });
  });

  it('fails a failed stream as unavailable with its usage, and an error event as unavailable', async () => {
    const failed = openAiResponse([], { status: 'failed', usage: usage(40, 0, 2) });
    const { provider: openai } = provider([
      {
        kind: 'sse',
        events: [{ type: 'response.failed', sequence_number: 1, response: failed }],
      },
    ]);
    await expect(collect(openai.stream(contractRequest))).rejects.toMatchObject({
      code: 'unavailable',
      usage: { inputTokens: 40, cachedInputTokens: 0, outputTokens: 2 },
    });
    const errored = provider([
      {
        kind: 'sse',
        events: [
          { type: 'error', sequence_number: 1, code: 'server_error', message: 'x', param: null },
        ],
      },
    ]);
    await expect(collect(errored.provider.stream(contractRequest))).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('treats a stream that ends without a response as invalid_response', async () => {
    const { provider: openai } = provider([
      {
        kind: 'sse',
        events: [
          {
            type: 'response.output_text.delta',
            sequence_number: 1,
            item_id: 'm',
            output_index: 0,
            content_index: 0,
            delta: 'Hi',
            logprobs: [],
          },
        ],
      },
    ]);
    await expect(collect(openai.stream(contractRequest))).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});

describe('toLlmResponse', () => {
  it('reads a completed text answer', () => {
    const response = toLlmResponse(
      openAiResponse([outputMessage('Hello')]) as unknown as OpenAiResponse,
    );
    expect(response).toMatchObject({ text: 'Hello', finishReason: 'stop', replay: [] });
  });
});
