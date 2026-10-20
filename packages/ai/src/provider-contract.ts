// Test-only (not built into dist): the behaviour every `LlmProvider` must show, run against
// the scripted fake and the OpenAI adapter alike (ADR-0027), so fakes can stand in for the
// real provider in every other test.
import type { LlmRequest, LlmStreamEvent } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { LlmError } from './errors.js';
import type { LlmProvider } from './provider.js';

/** What the provider under test should answer, described provider-neutrally. */
export type ContractScenario =
  | { kind: 'text'; text: string }
  | { kind: 'tool_call'; id: string; name: string; arguments: string }
  | { kind: 'refusal'; refusal: string }
  | { kind: 'length'; text: string }
  | { kind: 'error'; code: 'rate_limited' | 'unavailable' | 'auth' | 'bad_request' }
  | { kind: 'hang' };

/** Every scenario answers with these token counts. */
export const CONTRACT_USAGE = { inputTokens: 12, cachedInputTokens: 4, outputTokens: 3 };

export interface ProviderHarness {
  provider(scenario: ContractScenario): LlmProvider;
}

export const contractRequest: LlmRequest = {
  route: 'routine',
  instructions: 'You are Pepper, the AI employee of a hair salon.',
  messages: [{ role: 'user', content: 'Is Maria a client?' }],
  tools: [
    {
      name: 'find_clients',
      description: 'Look clients up by name.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
  toolChoice: 'auto',
  maxOutputTokens: 400,
};

async function collect(events: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const all: LlmStreamEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const error: unknown = await promise.then(
    () => new Error('expected the call to fail'),
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(LlmError);
  return error as LlmError;
}

export function providerContract(name: string, harness: ProviderHarness): void {
  describe(`LlmProvider contract: ${name} (ADR-0027)`, () => {
    it('answers text with usage and the model that answered', async () => {
      const response = await harness
        .provider({ kind: 'text', text: 'Yes, Maria Lopez is a client.' })
        .respond(contractRequest);
      expect(response).toMatchObject({
        text: 'Yes, Maria Lopez is a client.',
        toolCalls: [],
        finishReason: 'stop',
        usage: CONTRACT_USAGE,
      });
      expect(response.model.length).toBeGreaterThan(0);
    });

    it('returns tool calls with the raw arguments, untouched', async () => {
      const response = await harness
        .provider({
          kind: 'tool_call',
          id: 'call_1',
          name: 'find_clients',
          arguments: '{"query":"Maria"}',
        })
        .respond(contractRequest);
      expect(response.finishReason).toBe('tool_calls');
      expect(response.toolCalls).toEqual([
        { id: 'call_1', name: 'find_clients', arguments: '{"query":"Maria"}' },
      ]);
    });

    it('reports a refusal and an answer cut at the output limit', async () => {
      const refused = await harness
        .provider({ kind: 'refusal', refusal: 'I can’t help with that.' })
        .respond(contractRequest);
      expect(refused).toMatchObject({
        finishReason: 'refused',
        refusal: 'I can’t help with that.',
      });
      const cut = await harness
        .provider({ kind: 'length', text: 'Tomorrow you have' })
        .respond(contractRequest);
      expect(cut).toMatchObject({ finishReason: 'length', text: 'Tomorrow you have' });
    });

    it.each(['rate_limited', 'unavailable', 'auth', 'bad_request'] as const)(
      'fails with %s, retryable only when transient',
      async (code) => {
        const error = await failure(
          harness.provider({ kind: 'error', code }).respond(contractRequest),
        );
        expect(error.code).toBe(code);
        expect(error.retryable).toBe(code === 'rate_limited' || code === 'unavailable');
      },
    );

    it('stops with aborted when the caller cancels', async () => {
      const controller = new AbortController();
      const call = harness.provider({ kind: 'hang' }).respond(contractRequest, {
        signal: controller.signal,
      });
      setTimeout(() => {
        controller.abort();
      }, 20);
      expect((await failure(call)).code).toBe('aborted');
    });

    it('streams deltas that join to the text, then exactly one done', async () => {
      const text = 'Tomorrow is quiet: two haircuts.';
      const events = await collect(
        harness.provider({ kind: 'text', text }).stream(contractRequest),
      );
      const last = events.at(-1);
      expect(last?.type).toBe('done');
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      const deltas = events.flatMap((event) => (event.type === 'text_delta' ? [event.delta] : []));
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join('')).toBe(text);
      if (last?.type === 'done')
        expect(last.response).toMatchObject({ text, usage: CONTRACT_USAGE });
    });

    it('streams a failure as an LlmError', async () => {
      const stream = harness
        .provider({ kind: 'error', code: 'unavailable' })
        .stream(contractRequest);
      expect((await failure(collect(stream))).code).toBe('unavailable');
    });
  });
}
