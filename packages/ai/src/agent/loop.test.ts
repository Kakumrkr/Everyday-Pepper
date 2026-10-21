import type {
  ActionExecution,
  ChatEvent,
  ConversationId,
  LlmRequest,
  LlmToolCall,
} from '@pepper/contracts';
import { ManualClock, type Actor } from '@pepper/core';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse, waitForAbort } from '../scripted-provider.js';
import {
  idempotencyKeyOf,
  toolDefinitions,
  type ToolOutcome,
  type ToolTurn,
} from '../tools/registry.js';
import type { ToolDeps } from '../tools/tool.js';
import { CircuitBreaker } from './breaker.js';
import { STATIC_INSTRUCTIONS, type BusinessContext } from './context.js';
import {
  startTurn,
  turnKeyOf,
  type AgentDeps,
  type StartedTurn,
  type TokenBudget,
} from './loop.js';
import { MemoryConversationStore } from './store.js';

// The agent loop on the scripted fake, a store in memory and a fake dispatcher (ADR-0030):
// limits, errors, parallel reads and one-at-a-time writes, the fallback, untrusted context
// carried forward, cancelling, and recovering an abandoned turn without acting twice.

const NOW = new Date('2026-10-21T15:00:00Z');

const business: BusinessContext = {
  name: 'Juniper Hair Studio',
  timeZone: 'America/New_York',
  terminology: null,
  templateFragments: [],
  member: { firstName: 'Ana', role: 'owner' },
};

interface Dispatched {
  call: LlmToolCall;
  turn: ToolTurn;
  startedAt: number;
  endedAt: number;
}

/** A dispatcher that answers by tool name, records every call and how many ran at once. */
function fakeDispatch(
  options: {
    answer?: (call: LlmToolCall) => ToolOutcome;
    delayMs?: number;
    onCall?: (call: LlmToolCall) => void;
  } = {},
) {
  const calls: Dispatched[] = [];
  let running = 0;
  let maxRunning = 0;
  let tick = 0;
  const dispatch = async (
    _deps: ToolDeps,
    turn: ToolTurn,
    call: LlmToolCall,
  ): Promise<ToolOutcome> => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    tick += 1;
    const startedAt = tick;
    options.onCall?.(call);
    await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 5));
    running -= 1;
    tick += 1;
    calls.push({ call, turn, startedAt, endedAt: tick });
    return (
      options.answer?.(call) ??
      (call.name.startsWith('get_') ||
      call.name.startsWith('find_') ||
      call.name.startsWith('list_')
        ? {
            status: 'answered',
            tool: call.name,
            summary: `${call.name} answered`,
            data: {},
            card: null,
            untrustedText: false,
          }
        : {
            status: 'done',
            tool: call.name,
            summary: `${call.name} done`,
            card: {
              kind: 'change',
              tool: call.name,
              action: 'task.create',
              state: 'done',
              proposalId: null,
              fingerprint: null,
              executionId: null,
              undoUntil: null,
              before: null,
              after: null,
              emails: [],
            },
            execution: {} as ActionExecution,
          })
    );
  };
  return { dispatch, calls, maxRunning: () => maxRunning };
}

const call = (id: string, name: string, args: unknown = {}): LlmToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

interface Setup {
  provider?: ScriptedProvider | null;
  dispatch?: ReturnType<typeof fakeDispatch>;
  budget?: TokenBudget;
  clock?: ManualClock;
  breaker?: CircuitBreaker;
  store?: MemoryConversationStore;
  limits?: AgentDeps['limits'];
}

function setup(options: Setup = {}) {
  const clock = options.clock ?? new ManualClock(NOW);
  const store = options.store ?? new MemoryConversationStore();
  const dispatch = options.dispatch ?? fakeDispatch();
  const reservations: { estimate: number; used: number | null }[] = [];
  const budget: TokenBudget = options.budget ?? {
    reserve: (estimate) => {
      const reservation = { estimate, used: null as number | null };
      reservations.push(reservation);
      return Promise.resolve({
        state: 'ok' as const,
        settle: (used: number) => {
          reservation.used = used;
          return Promise.resolve();
        },
      });
    },
  };
  const deps: AgentDeps = {
    provider: options.provider === undefined ? new ScriptedProvider([]) : options.provider,
    tools: { clock, actor: {} as Actor } as unknown as ToolDeps,
    store,
    budget,
    breaker: options.breaker ?? new CircuitBreaker(clock),
    business,
    cacheKey: 'biz_test',
    safetyId: 'member_test',
    dispatch: dispatch.dispatch,
    ...(options.limits !== undefined && { limits: options.limits }),
  };
  return { deps, store, dispatch, clock, reservations };
}

let clientTurns = 0;

async function turnOf(
  deps: AgentDeps,
  message = 'What does tomorrow look like?',
  conversationId: ConversationId | null = null,
  clientTurnId?: string,
): Promise<StartedTurn> {
  clientTurns += 1;
  return startTurn(deps, {
    clientTurnId:
      clientTurnId ?? `0199f4b2-7c1e-7a00-8000-${String(clientTurns).padStart(12, 'f')}`,
    conversationId,
    message,
    channel: 'chat',
  });
}

async function run(
  deps: AgentDeps,
  message?: string,
  conversationId?: ConversationId | null,
  signal?: AbortSignal,
) {
  const started = await turnOf(deps, message, conversationId ?? null);
  if (started.kind !== 'started') throw new Error(`not started: ${started.kind}`);
  const events: ChatEvent[] = [];
  const reason = await started.run((event) => {
    events.push(event);
  }, signal);
  return { started, events, reason };
}

const types = (events: ChatEvent[]) => events.map((event) => event.type);
const fallbackOf = (events: ChatEvent[]) => {
  const last = events.at(-1);
  return last?.type === 'turn.failed' ? last.fallback : null;
};

describe('a turn', () => {
  it('answers in one step and records the conversation', async () => {
    const provider = new ScriptedProvider([scriptedResponse({ text: 'Tomorrow is free.' })]);
    const { deps, store } = setup({ provider });
    const { events, reason, started } = await run(
      deps,
      'Email maria.lopez@example.test about tomorrow',
    );
    expect(reason).toBe('answered');
    expect(types(events)).toEqual([
      'turn.started',
      'text.delta',
      'text.delta',
      'text.delta',
      'message.completed',
      'turn.completed',
    ]);
    const [request] = provider.requests;
    expect(request?.instructions.startsWith(STATIC_INSTRUCTIONS)).toBe(true);
    expect(request?.tools).toEqual(toolDefinitions());
    expect(request?.cacheKey).toBe('biz_test');
    // The member's message went without the address; the store keeps their words.
    expect(JSON.stringify(request?.messages)).not.toContain('maria.lopez@example.test');
    expect(store.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(store.turns.get(started.turn.id)?.status).toBe('completed');
  });

  it('runs reads at the same time and writes one at a time, in order, after the reads', async () => {
    const dispatch = fakeDispatch({ delayMs: 20 });
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [
          call('c1', 'add_todo', { title: 'one' }),
          call('c2', 'get_day'),
          call('c3', 'find_clients'),
          call('c4', 'block_time', { n: 2 }),
          call('c5', 'get_booking'),
        ],
      }),
      scriptedResponse({ text: 'Done.' }),
    ]);
    const { deps, store } = setup({ provider, dispatch });
    const { reason } = await run(deps);
    expect(reason).toBe('answered');
    const order = dispatch.calls.map((each) => each.call.id);
    const reads = dispatch.calls.filter((each) => ['c2', 'c3', 'c5'].includes(each.call.id));
    const writes = dispatch.calls.filter((each) => ['c1', 'c4'].includes(each.call.id));
    expect(dispatch.maxRunning()).toBe(3);
    // Writes after every read, one at a time, in the model's order.
    expect(Math.min(...writes.map((each) => each.startedAt))).toBeGreaterThan(
      Math.max(...reads.map((each) => each.endedAt)),
    );
    expect(order.filter((id) => id === 'c1' || id === 'c4')).toEqual(['c1', 'c4']);
    const [first, second] = writes;
    expect((second?.startedAt ?? 0) > (first?.endedAt ?? 0)).toBe(true);
    // The results go back to the model in call order.
    const second_request = provider.requests[1];
    expect(
      second_request?.messages
        .filter((message) => message.role === 'tool')
        .map((message) => message.toolCallId),
    ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    expect(store.messages.filter((message) => message.role === 'tool')).toHaveLength(5);
  });

  it('stops at the step limit with the fallback', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 6 }, (_unused, index) =>
        scriptedResponse({ toolCalls: [call(`c${String(index)}`, 'get_day')] }),
      ),
    );
    const { deps, store } = setup({ provider });
    const { reason, events, started } = await run(deps);
    expect(reason).toBe('step_limit');
    expect(provider.requests).toHaveLength(6);
    expect(fallbackOf(events)?.link).toEqual({ label: 'Calendar', href: '/calendar' });
    expect(store.turns.get(started.turn.id)?.stopReason).toBe('step_limit');
  });

  it('stops at the time limit, and starts no write once the time is up', async () => {
    const clock = new ManualClock(NOW);
    const dispatch = fakeDispatch({
      onCall: (each) => {
        if (each.name === 'get_day') clock.advanceBy(21_000);
      },
    });
    const provider = new ScriptedProvider([
      scriptedResponse({ toolCalls: [call('c1', 'get_day'), call('c2', 'create_booking')] }),
    ]);
    const { deps } = setup({ provider, dispatch, clock });
    const { reason, events } = await run(deps);
    expect(reason).toBe('time_limit');
    expect(dispatch.calls.map((each) => each.call.name)).toEqual(['get_day']);
    expect(fallbackOf(events)?.reason).toBe('time_limit');
  });

  it('makes at most five changes in a turn and refuses the rest with turn_limit', async () => {
    const dispatch = fakeDispatch();
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: Array.from({ length: 7 }, (_unused, index) =>
          call(`w${String(index)}`, 'add_todo', { n: index }),
        ),
      }),
      scriptedResponse({ text: 'I added five; ask me for the rest.' }),
    ]);
    const { deps } = setup({ provider, dispatch, limits: { maxCallsPerStep: 8 } });
    const { reason, events } = await run(deps);
    expect(reason).toBe('answered');
    expect(dispatch.calls).toHaveLength(5);
    const refusals = events.filter(
      (event) => event.type === 'tool.finished' && event.code === 'turn_limit',
    );
    expect(refusals).toHaveLength(0); // refused before they ran: no tool events, but a result for the model
    const results =
      provider.requests[1]?.messages.filter((message) => message.role === 'tool') ?? [];
    expect(results.filter((message) => message.content.includes('turn_limit'))).toHaveLength(2);
  });

  it('refuses a call id repeated in one answer, and gives a reused id another key in a later step', async () => {
    const dispatch = fakeDispatch();
    const provider = new ScriptedProvider([
      scriptedResponse({
        toolCalls: [call('call_1', 'add_todo', { a: 1 }), call('call_1', 'add_todo', { a: 2 })],
      }),
      scriptedResponse({ toolCalls: [call('call_1', 'add_todo', { a: 3 })] }),
      scriptedResponse({ text: 'Done.' }),
    ]);
    const { deps } = setup({ provider, dispatch });
    await run(deps);
    expect(dispatch.calls.map((each) => [each.turn.step, each.call.arguments])).toEqual([
      [1, '{"a":1}'],
      [2, '{"a":3}'],
    ]);
    const [first, second] = dispatch.calls;
    if (first === undefined || second === undefined) throw new Error('two calls');
    expect(idempotencyKeyOf(first.turn, first.call.id)).not.toBe(
      idempotencyKeyOf(second.turn, second.call.id),
    );
    expect(first.turn.turnKey).toMatch(/^conv:[0-9a-f-]{36}:turn:[0-9a-f-]{36}$/);
  });
});

describe('when the model fails', () => {
  it('retries a retryable failure once, then answers with the fallback', async () => {
    const provider = new ScriptedProvider([
      new LlmError('unavailable', 'down'),
      new LlmError('unavailable', 'down'),
    ]);
    const { deps, reservations } = setup({ provider });
    const { reason, events } = await run(deps);
    expect(reason).toBe('provider_unavailable');
    expect(provider.requests).toHaveLength(2);
    expect(fallbackOf(events)?.text).toContain('can’t reach my AI');
    // Both reservations were given back.
    expect(reservations.map((each) => each.used)).toEqual([0, 0]);
  });

  it('does not retry a bad request, and a retry after a failure can succeed', async () => {
    const bad = setup({ provider: new ScriptedProvider([new LlmError('bad_request', 'no')]) });
    expect((await run(bad.deps)).reason).toBe('provider_unavailable');
    const flaky = setup({
      provider: new ScriptedProvider([
        new LlmError('rate_limited', 'slow down'),
        scriptedResponse({ text: 'Hi.' }),
      ]),
    });
    expect((await run(flaky.deps)).reason).toBe('answered');
  });

  it('opens the breaker after failures and answers at once without calling', async () => {
    const clock = new ManualClock(NOW);
    const breaker = new CircuitBreaker(clock, { failures: 2, openForMs: 30_000 });
    const provider = new ScriptedProvider([
      new LlmError('timeout', 'slow'),
      new LlmError('timeout', 'slow'),
    ]);
    const { deps } = setup({ provider, clock, breaker });
    expect((await run(deps)).reason).toBe('provider_unavailable');
    expect(breaker.isOpen).toBe(true);
    const { reason, events } = await run(deps);
    expect(reason).toBe('provider_unavailable');
    expect(provider.requests).toHaveLength(2);
    expect(types(events)).toEqual(['turn.started', 'turn.failed']);
  });

  it('answers ai_off without a provider, and a refusal by the model with the fallback', async () => {
    expect((await run(setup({ provider: null }).deps)).reason).toBe('ai_off');
    const refused = setup({
      provider: new ScriptedProvider([
        scriptedResponse({ finishReason: 'refused', refusal: 'No.' }),
      ]),
    });
    const { reason, events } = await run(refused.deps);
    expect(reason).toBe('provider_refused');
    expect(fallbackOf(events)?.link).toBeNull();
  });

  it('pauses the AI when the budget is used up, without calling the model', async () => {
    const provider = new ScriptedProvider([]);
    const { deps } = setup({ provider, budget: { reserve: () => Promise.resolve(null) } });
    const { reason, events } = await run(deps);
    expect(reason).toBe('budget_exhausted');
    expect(provider.requests).toHaveLength(0);
    expect(fallbackOf(events)?.text).toContain('allowance');
  });

  it('cancels when the member stops the turn', async () => {
    const controller = new AbortController();
    const provider = new ScriptedProvider([
      (_request, options) => {
        setTimeout(() => {
          controller.abort();
        }, 5);
        return waitForAbort(options.signal);
      },
    ]);
    const { deps } = setup({ provider });
    const { reason, events } = await run(deps, undefined, null, controller.signal);
    expect(reason).toBe('cancelled');
    expect(fallbackOf(events)?.reason).toBe('cancelled');
  });

  it('keeps going when the events can’t be delivered (the member left)', async () => {
    const { deps, store } = setup({
      provider: new ScriptedProvider([scriptedResponse({ text: 'Hi.' })]),
    });
    const started = await turnOf(deps);
    if (started.kind !== 'started') throw new Error('not started');
    const reason = await started.run(() => {
      throw new Error('connection closed');
    });
    expect(reason).toBe('answered');
    expect(store.turns.get(started.turn.id)?.status).toBe('completed');
  });
});

describe('routing and budget', () => {
  it('uses the stronger model for a long plan, but never past the soft budget', async () => {
    const plan = () =>
      new ScriptedProvider([
        ...Array.from({ length: 4 }, (_unused, index) =>
          scriptedResponse({ toolCalls: [call(`c${String(index)}`, 'get_day')] }),
        ),
        scriptedResponse({ text: 'Done.' }),
      ]);
    const ok = plan();
    await run(setup({ provider: ok }).deps);
    expect(ok.requests.map((request: LlmRequest) => request.route)).toEqual([
      'routine',
      'routine',
      'routine',
      'strong',
      'strong',
    ]);
    const soft = plan();
    await run(
      setup({
        provider: soft,
        budget: {
          reserve: () => Promise.resolve({ state: 'soft', settle: () => Promise.resolve() }),
        },
      }).deps,
    );
    expect(new Set(soft.requests.map((request) => request.route))).toEqual(new Set(['routine']));
  });

  it('meters every call with what it used', async () => {
    const provider = new ScriptedProvider([
      scriptedResponse({
        text: 'Hi.',
        usage: { inputTokens: 1_200, cachedInputTokens: 1_000, outputTokens: 30 },
      }),
    ]);
    const { deps, reservations, store } = setup({ provider });
    const { started } = await run(deps);
    expect(reservations.map((each) => each.used)).toEqual([1_230]);
    expect(reservations[0]?.estimate).toBeGreaterThan(800);
    expect(store.turns.get(started.turn.id)?.progress).toMatchObject({
      inputTokens: 1_200,
      cachedInputTokens: 1_000,
      outputTokens: 30,
    });
  });
});

describe('untrusted context', () => {
  it('marks the turn untrusted from a tool answer, for the writes after it and the next turn', async () => {
    const dispatch = fakeDispatch({
      answer: (each) =>
        each.name === 'get_booking'
          ? {
              status: 'answered',
              tool: 'get_booking',
              summary: 'A note',
              data: {},
              card: null,
              untrustedText: true,
            }
          : {
              status: 'answered',
              tool: each.name,
              summary: 'ok',
              data: {},
              card: null,
              untrustedText: false,
            },
    });
    const provider = new ScriptedProvider([
      scriptedResponse({ toolCalls: [call('c1', 'get_booking')] }),
      scriptedResponse({ toolCalls: [call('c2', 'move_booking')] }),
      scriptedResponse({ text: 'Moved.' }),
      // The next turn: the labelled answer is still in the history.
      scriptedResponse({ toolCalls: [call('c3', 'cancel_booking')] }),
      scriptedResponse({ text: 'Cancelled.' }),
    ]);
    const { deps, store } = setup({ provider, dispatch });
    const first = await run(deps);
    expect(dispatch.calls.map((each) => [each.call.name, each.turn.untrustedContext])).toEqual([
      ['get_booking', false],
      ['move_booking', true],
    ]);
    expect(store.turns.get(first.started.turn.id)?.untrusted).toBe(true);
    // Every answer written after it is tainted too, and the result is labelled when re-sent.
    expect(
      store.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => message.untrusted),
    ).toEqual([false, true, true]);
    const resent = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(resent?.role === 'tool' && resent.content.startsWith('{"untrusted_data":')).toBe(true);
    await run(deps, 'Now cancel it', first.started.turn.conversationId);
    expect(dispatch.calls.at(-1)?.turn.untrustedContext).toBe(true);
  });
});

describe('startTurn', () => {
  it('gives a retried request its turn and a second message to a busy conversation busy', async () => {
    const { deps } = setup({ provider: new ScriptedProvider([scriptedResponse({ text: 'Hi.' })]) });
    const clientTurnId = '0199f4b2-7c1e-7a00-8000-0000000000aa';
    const first = await turnOf(deps, 'Hi', null, clientTurnId);
    if (first.kind !== 'started') throw new Error('not started');
    expect((await turnOf(deps, 'Hi', null, clientTurnId)).kind).toBe('existing');
    expect((await turnOf(deps, 'Again', first.turn.conversationId)).kind).toBe('busy');
    await first.run(() => undefined);
    expect((await turnOf(deps, 'Hi', null, clientTurnId)).kind).toBe('existing');
  });

  it('recovers an abandoned turn from its records, never calling a tool or the model again', async () => {
    const clock = new ManualClock(NOW);
    const store = new MemoryConversationStore();
    const dispatch = fakeDispatch();
    const provider = new ScriptedProvider([scriptedResponse({ text: 'Hi again.' })]);
    const { deps } = setup({ provider, store, clock, dispatch });
    // A turn that recorded two write calls and then its server stopped.
    const abandoned = await turnOf(deps, 'Book Maria and add a to-do');
    if (abandoned.kind !== 'started') throw new Error('not started');
    await store.record(
      abandoned.turn,
      [
        {
          role: 'assistant',
          content: '',
          step: 1,
          toolCalls: [call('w1', 'create_booking'), call('w2', 'add_todo'), call('r1', 'get_day')],
          replay: [],
          untrusted: false,
        },
      ],
      null,
    );
    const turnKey = turnKeyOf(abandoned.turn);
    const key = idempotencyKeyOf(
      { turnKey, step: 1, requestMessageId: null, untrustedContext: false },
      'w1',
    );
    store.results.set(key, { kind: 'executed', execution: {} as ActionExecution });
    clock.advanceBy(20_000 + 30_001);
    const next = await turnOf(deps, 'Hello?', abandoned.turn.conversationId);
    expect(next.kind).toBe('started');
    expect(store.turns.get(abandoned.turn.id)).toMatchObject({
      status: 'failed',
      stopReason: 'interrupted',
    });
    const recovered = store.messages.filter(
      (message) => message.turnId === abandoned.turn.id && message.role === 'tool',
    );
    expect(
      recovered.map((message) => [message.toolCallId, JSON.parse(message.content).status]),
    ).toEqual([
      ['w1', 'done'],
      ['w2', 'refused'],
      ['r1', 'refused'],
    ]);
    expect(dispatch.calls).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
  });
});
