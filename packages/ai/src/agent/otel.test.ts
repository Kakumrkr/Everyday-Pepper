import type { ActionExecution, LlmToolCall } from '@pepper/contracts';
import { ManualClock, type Actor } from '@pepper/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import type { ToolOutcome, ToolTurn } from '../tools/registry.js';
import type { ToolDeps } from '../tools/tool.js';
import { CircuitBreaker } from './breaker.js';
import { startTurn, type AgentDeps } from './loop.js';
import { otelTurnTracer } from './otel.js';
import { MemoryConversationStore } from './store.js';

// The loop's spans (ADR-0030, playbook principle 15): one turn with its model calls and tool
// calls under it, after the GenAI conventions, and nothing anyone typed in any attribute.

const SECRETS = [
  'maria.lopez@example.test',
  'WORDS_OF_THE_MEMBER',
  'WORDS_OF_THE_MODEL',
  'ARGUMENT_TEXT',
  'ANSWER_TEXT',
];

function run(provider: ScriptedProvider) {
  const exporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const clock = new ManualClock(new Date('2026-10-21T15:00:00Z'));
  const dispatch = (_deps: ToolDeps, _turn: ToolTurn, call: LlmToolCall): Promise<ToolOutcome> =>
    Promise.resolve(
      call.name === 'add_todo'
        ? {
            status: 'done',
            tool: 'add_todo',
            summary: 'Added ANSWER_TEXT',
            card: null as never,
            execution: {} as ActionExecution,
            untrustedText: false,
          }
        : {
            status: 'refused',
            tool: 'unknown_tool',
            code: 'unknown_tool',
            message: 'No such tool',
            alternatives: [],
            card: null,
            error: null,
          },
    );
  const deps: AgentDeps = {
    provider,
    tools: { clock, actor: {} as Actor } as unknown as ToolDeps,
    store: new MemoryConversationStore(),
    budget: { reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }) },
    breaker: new CircuitBreaker(clock),
    business: {
      name: 'Juniper',
      timeZone: 'America/New_York',
      terminology: null,
      templateFragments: [],
      member: { firstName: 'Ana', role: 'owner' },
    },
    cacheKey: 'b_test',
    safetyId: 'm_test',
    tracer: otelTurnTracer(tracerProvider.getTracer('test')),
    dispatch: (deps, turn, call) => dispatch(deps, turn, call),
  };
  return { deps, exporter };
}

async function oneTurn(deps: AgentDeps) {
  const started = await startTurn(deps, {
    clientTurnId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
    conversationId: null,
    message: 'Remind me: email maria.lopez@example.test WORDS_OF_THE_MEMBER',
    channel: 'chat',
  });
  if (started.kind !== 'started') throw new Error('not started');
  return started.run(() => undefined);
}

describe('otelTurnTracer', () => {
  it('nests model and tool spans under the turn, with GenAI attributes and no contents', async () => {
    const provider = new ScriptedProvider([
      scriptedResponse({
        text: 'WORDS_OF_THE_MODEL',
        toolCalls: [
          { id: 'c1', name: 'add_todo', arguments: JSON.stringify({ title: 'ARGUMENT_TEXT' }) },
          { id: 'c2', name: 'drop_tables', arguments: '{}' },
        ],
        usage: { inputTokens: 1_200, cachedInputTokens: 1_024, outputTokens: 40 },
        model: 'model-small',
      }),
      scriptedResponse({ text: 'WORDS_OF_THE_MODEL done.', model: 'model-small' }),
    ]);
    const { deps, exporter } = run(provider);
    expect(await oneTurn(deps)).toBe('answered');
    const spans = exporter.getFinishedSpans();
    const turn = spans.find((span) => span.name === 'chat.turn');
    expect(turn?.attributes).toMatchObject({
      'pepper.chat.channel': 'chat',
      'pepper.turn.stop_reason': 'answered',
      'pepper.turn.steps': 2,
      'gen_ai.usage.input_tokens': 1_200,
      'gen_ai.usage.cache_read.input_tokens': 1_024,
    });
    const calls = spans.filter((span) => span.name.startsWith('chat '));
    expect(calls.map((span) => span.attributes['gen_ai.response.model'])).toEqual([
      'model-small',
      'model-small',
    ]);
    expect(calls[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.usage.output_tokens': 40,
      'pepper.llm.route': 'routine',
    });
    const tools = spans.filter((span) => span.name.startsWith('execute_tool'));
    expect(tools.map((span) => span.name).sort()).toEqual([
      'execute_tool add_todo',
      'execute_tool unknown_tool',
    ]);
    expect(
      tools.find((span) => span.name.endsWith('unknown_tool'))?.attributes[
        'pepper.tool.error_code'
      ],
    ).toBe('unknown_tool');
    for (const span of [...calls, ...tools]) {
      expect(span.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
    }
    const everything = JSON.stringify(
      spans.map((span) => [span.name, span.attributes, span.events]),
    );
    for (const secret of SECRETS) expect(everything).not.toContain(secret);
  });

  it('marks a failed model call with its error code', async () => {
    const { deps, exporter } = run(new ScriptedProvider([new LlmError('auth', 'bad key')]));
    expect(await oneTurn(deps)).toBe('provider_unavailable');
    const failed = exporter.getFinishedSpans().find((span) => span.name === 'chat');
    expect(failed?.attributes['error.type']).toBe('auth');
    expect(failed?.status.code).toBe(2);
  });
});
