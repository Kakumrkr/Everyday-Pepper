import {
  ANSWER_FACTS_MAX,
  ChatEventSchema,
  MemoryFactIdSchema,
  type ChatChannel,
  type ChatEvent,
  type ConversationId,
  type ConversationMessageId,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
  type ToolErrorCode,
  type TurnStopReason,
} from '@pepper/contracts';
import type {
  BeginTurnResult,
  StoredMessage,
  TurnMessage,
  TurnProgress,
  TurnView,
} from '@pepper/core';
import { isLlmError, LlmError } from '../errors.js';
import type { LlmProvider } from '../provider.js';
import {
  dispatchToolCall,
  findTool,
  idempotencyKeyOf,
  toolMessageContent,
  type ToolOutcome,
  type ToolTurn,
} from '../tools/registry.js';
import type { ToolDeps } from '../tools/tool.js';
import type { CircuitBreaker } from './breaker.js';
import {
  agentTools,
  contextMessageOf,
  estimateTokens,
  instructionsFor,
  messageTokens,
  trimHistory,
  type BusinessContext,
} from './context.js';
import { fallbackFor, type DoneSoFar } from './fallback.js';
import {
  episodeIdsIn,
  factIdsIn,
  type MemoryReader,
  type RecalledEpisode,
  type RecalledFact,
} from './memory.js';
import { LinkScrubber, withoutLinks } from './links.js';
import { routeFor } from './routing.js';
import type { ConversationStore } from './store.js';
import { noTracing, type TurnSpan, type TurnTracer } from './tracing.js';

// The agent loop (ADR-0030, playbook principles 1, 7, 10, 12–15). A turn is the member's
// message and everything done to answer it; it works on events, not on HTTP, so chat and
// (later) voice share it. Each step: assemble the context, reserve tokens, ask the model, record
// its answer *before* acting on it, run its tool calls (reads in parallel, writes one at a time)
// through `dispatchToolCall` only, record the results. It never holds a transaction across a
// model call, never takes the business or member from the model, and ends every turn with an
// answer or the deterministic fallback.

export interface LoopLimits {
  /** Model calls per turn. */
  maxSteps: number;
  /** Wall-clock time for the whole turn. */
  turnMs: number;
  /** Longest single model call (bounded by what is left of the turn). */
  callMs: number;
  /** Changes (write tool calls) one turn may make. */
  maxWrites: number;
  /** Tool calls taken from one model answer; more are refused. */
  maxCallsPerStep: number;
  /** Reads run at the same time. */
  readConcurrency: number;
  /** Estimated tokens of earlier turns sent as history. */
  historyTokens: number;
  maxOutputTokens: number;
}

export const DEFAULT_LIMITS: LoopLimits = {
  maxSteps: 6,
  turnMs: 20_000,
  callMs: 15_000,
  maxWrites: 5,
  maxCallsPerStep: 8,
  readConcurrency: 4,
  historyTokens: 6_000,
  maxOutputTokens: 800,
};

/** Tokens reserved from the business's budget for one model call (`@pepper/core`). */
export interface TokenBudget {
  reserve(estimate: number): Promise<{
    state: 'ok' | 'soft';
    settle(usedTokens: number): Promise<void>;
  } | null>;
}

export interface AgentDeps {
  /** `null`: no provider is configured; every turn answers `ai_off`. */
  provider: LlmProvider | null;
  /** The member, the business's database, clock and template data, for the tools. */
  tools: ToolDeps;
  store: ConversationStore;
  budget: TokenBudget;
  breaker: CircuitBreaker;
  business: BusinessContext;
  /** Prompt-cache routing (one per business) and the provider's abuse id (a hash of the member). */
  cacheKey: string;
  safetyId: string;
  limits?: Partial<LoopLimits>;
  tracer?: TurnTracer;
  /** For tests: the dispatcher (the registry's in the app). */
  dispatch?: typeof dispatchToolCall;
  /**
   * Reads remembered facts as the member (`memberMemory`, S30). Without it nothing remembered
   * is sent: the references in tool answers are left out.
   */
  memory?: MemoryReader;
}

export interface TurnRequest {
  clientTurnId: string;
  conversationId: ConversationId | null;
  message: string;
  channel: ChatChannel;
}

/** Receives a turn's events in order. Failing to deliver one never stops the turn. */
export type EmitEvent = (event: ChatEvent) => void | Promise<void>;

export type StartedTurn =
  | {
      kind: 'started';
      turn: TurnView;
      requestMessageId: ConversationMessageId;
      /** Runs the turn to its end; never rejects. */
      run(emit: EmitEvent, signal?: AbortSignal): Promise<TurnStopReason>;
    }
  | { kind: 'existing'; turn: TurnView }
  | { kind: 'busy'; turn: TurnView };

/**
 * Starts a turn for the member's message. A retried request (same client turn id) gets the
 * existing turn and never a second run; a conversation still answering gets `busy`; a turn its
 * server abandoned is recovered first (nothing runs twice or late), then this one starts.
 */
export async function startTurn(deps: AgentDeps, request: TurnRequest): Promise<StartedTurn> {
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };
  const begin = () => {
    const now = deps.tools.clock.now();
    return deps.store.begin({
      ...request,
      deadlineAt: new Date(now.getTime() + limits.turnMs),
      now,
    });
  };
  let begun: BeginTurnResult = await begin();
  if (begun.kind === 'stale') {
    await recoverTurn(deps, begun.turn);
    begun = await begin();
  }
  if (begun.kind === 'stale') return { kind: 'busy', turn: begun.turn };
  if (begun.kind !== 'started') return begun;
  const { turn, requestMessageId } = begun;
  return {
    kind: 'started',
    turn,
    requestMessageId,
    run: (emit, signal) =>
      runTurn(deps, limits, turn, requestMessageId, request.message, emit, signal),
  };
}

/** The turn's key for the tools' idempotency keys: `(conversation, turn)`. */
export function turnKeyOf(turn: Pick<TurnView, 'id' | 'conversationId'>): string {
  return `conv:${turn.conversationId}:turn:${turn.id}`;
}

class StopTurn extends Error {
  constructor(readonly reason: Exclude<TurnStopReason, 'answered'>) {
    super(reason);
  }
}

interface Step {
  outcomes: ToolOutcome[];
}

async function runTurn(
  deps: AgentDeps,
  limits: LoopLimits,
  turn: TurnView,
  requestMessageId: ConversationMessageId,
  message: string,
  emit: EmitEvent,
  signal?: AbortSignal,
): Promise<TurnStopReason> {
  const clock = deps.tools.clock;
  const tracer = deps.tracer ?? noTracing;
  const dispatch = deps.dispatch ?? dispatchToolCall;
  const deadline = turn.deadlineAt.getTime();
  const progress: TurnProgress = {
    steps: 0,
    untrusted: false,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  const done: DoneSoFar[] = [];
  let writes = 0;
  let invalidCalls = 0;

  const send = async (event: ChatEvent) => {
    try {
      await emit(ChatEventSchema.parse(event));
    } catch {
      // The member may have left; the turn still finishes and is recorded.
    }
  };

  const span = tracer.turn({ channel: 'chat' });
  let reason: TurnStopReason;
  try {
    await send({
      type: 'turn.started',
      conversationId: turn.conversationId,
      turnId: turn.id,
      requestMessageId,
    });
    const history: StoredMessage[] = await deps.store.history(turn.conversationId, 80);
    const businessFacts = (await deps.memory?.businessFacts()) ?? [];
    const instructions = instructionsFor(deps.business, turn.startedAt, businessFacts);
    // What the business remembers came from people's words: the turn is untrusted (principle
    // 4), though not text from outside the team (that one also makes memory saves ask).
    let remembered = businessFacts.length > 0;
    const tools = agentTools();
    let recalled: string[] = [];

    for (;;) {
      if (signal?.aborted === true) throw new StopTurn('cancelled');
      if (clock.now().getTime() >= deadline) throw new StopTurn('time_limit');
      if (progress.steps >= limits.maxSteps) throw new StopTurn('step_limit');
      if (deps.provider === null) throw new StopTurn('ai_off');
      progress.steps += 1;
      const step = progress.steps;

      const facts = await recallFacts(deps.memory, history);
      const episodes = await recallEpisodes(deps.memory, history);
      const context = trimHistory(
        history.map((stored) => contextMessageOf(stored, facts, episodes)),
        turn.id,
        limits.historyTokens,
      );
      progress.untrusted ||= context.untrusted;
      remembered ||= context.remembered;
      // The facts this turn's answers brought, for *Why?* (by id).
      recalled = [
        ...new Set(
          history
            .filter((stored) => stored.turnId === turn.id && stored.role === 'tool')
            .flatMap((stored) => factIdsIn(stored.content))
            .filter((id) => facts.has(id)),
        ),
      ];
      const request: LlmRequest = {
        route: 'routine',
        instructions,
        messages: context.messages,
        tools,
        toolChoice: 'auto',
        maxOutputTokens: limits.maxOutputTokens,
        cacheKey: deps.cacheKey,
        safetyId: deps.safetyId,
      };
      const response = await callModel(deps, limits, request, {
        deadline,
        step,
        invalidCalls,
        signal,
        send,
        span,
      });
      progress.inputTokens += response.usage.inputTokens;
      progress.cachedInputTokens += response.usage.cachedInputTokens;
      progress.outputTokens += response.usage.outputTokens;
      if (response.finishReason === 'refused' || response.finishReason === 'content_filter') {
        throw new StopTurn('provider_refused');
      }

      const calls = response.toolCalls;
      // Written before anything runs: a server that stops now leaves a record of the calls.
      const [answer] = await deps.store.record(
        turn,
        [
          {
            role: 'assistant',
            content: response.text,
            step,
            toolCalls: calls,
            replay: response.replay,
            untrusted: progress.untrusted,
          },
        ],
        progress,
      );
      if (answer !== undefined) {
        history.push(answer);
        if (response.text.trim() !== '') {
          await send({
            type: 'message.completed',
            messageId: answer.id,
            text: response.text,
            factIds: recalled.slice(0, ANSWER_FACTS_MAX).map((id) => MemoryFactIdSchema.parse(id)),
          });
        }
      }

      if (calls.length === 0) {
        if (response.text.trim() === '') throw new StopTurn('internal');
        reason = 'answered';
        break;
      }

      const toolTurn = (): ToolTurn => ({
        turnKey: turnKeyOf(turn),
        step,
        requestMessageId,
        untrustedContext: progress.untrusted || remembered,
        outsideText: progress.untrusted,
        turnId: turn.id,
        recalled,
      });
      const { outcomes } = await runCalls(
        { dispatch, deps, limits, deadline, toolTurn, send, span },
        calls,
        () => writes,
        () => {
          writes += 1;
        },
      );
      const results: TurnMessage[] = calls.map((call, index) => {
        const outcome = outcomes[index] ?? notRun(call.name, 'internal');
        const untrusted = outcome.status !== 'refused' && outcome.untrustedText;
        if (untrusted) progress.untrusted = true;
        if (
          outcome.status === 'refused' &&
          (outcome.code === 'invalid_arguments' || outcome.code === 'unknown_tool')
        ) {
          invalidCalls += 1;
        }
        if (outcome.status === 'done' || outcome.status === 'awaiting_approval') {
          done.push({ status: outcome.status, summary: outcome.summary });
        }
        return {
          role: 'tool',
          content: toolMessageContent(outcome),
          step,
          toolCallId: call.id,
          toolName: findTool(call.name)?.name ?? 'unknown_tool',
          isError: outcome.status === 'refused',
          card: outcome.card,
          untrusted,
        };
      });
      history.push(...(await deps.store.record(turn, unique(results), progress)));
    }
  } catch (error) {
    reason = error instanceof StopTurn ? error.reason : 'internal';
    if (!(error instanceof StopTurn)) span.error(error);
  }

  if (reason === 'answered') {
    await send({ type: 'turn.completed', reason: 'answered' });
  } else {
    await send({ type: 'turn.failed', fallback: fallbackFor(reason, { message, done }) });
  }
  try {
    await deps.store.end(turn.id, reason, progress);
  } catch (error) {
    span.error(error);
  }
  span.end({ reason, steps: progress.steps, untrusted: progress.untrusted, usage: progress });
  return reason;
}

/** The remembered facts the history's tool answers name, read live (none without a reader). */
async function recallFacts(
  memory: MemoryReader | undefined,
  history: readonly StoredMessage[],
): Promise<Map<string, RecalledFact>> {
  if (memory === undefined) return new Map();
  const ids = [
    ...new Set(
      history.flatMap((stored) => (stored.role === 'tool' ? factIdsIn(stored.content) : [])),
    ),
  ];
  return ids.length === 0 ? new Map() : memory.facts(ids);
}

/** The member's episodes the history's tool answers name, read live (S31). */
async function recallEpisodes(
  memory: MemoryReader | undefined,
  history: readonly StoredMessage[],
): Promise<Map<string, RecalledEpisode>> {
  if (memory?.episodes === undefined) return new Map();
  const ids = [
    ...new Set(
      history.flatMap((stored) => (stored.role === 'tool' ? episodeIdsIn(stored.content) : [])),
    ),
  ];
  return ids.length === 0 ? new Map() : memory.episodes(ids);
}

/** One tool result per call id: a model that repeats an id gets one answer for it. */
function unique(results: TurnMessage[]): TurnMessage[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (result.role !== 'tool') return true;
    if (seen.has(result.toolCallId)) return false;
    seen.add(result.toolCallId);
    return true;
  });
}

interface CallContext {
  deadline: number;
  step: number;
  invalidCalls: number;
  signal: AbortSignal | undefined;
  send: (event: ChatEvent) => Promise<void>;
  span: TurnSpan;
}

/** Retryable provider failures get one more try, if time allows and nothing was streamed. */
async function callModel(
  deps: AgentDeps,
  limits: LoopLimits,
  request: LlmRequest,
  context: CallContext,
): Promise<LlmResponse> {
  const provider = deps.provider;
  if (provider === null) throw new StopTurn('ai_off');
  const estimate =
    estimateTokens(request.instructions) +
    estimateTokens(JSON.stringify(request.tools)) +
    request.messages.reduce((sum, message) => sum + messageTokens(message), 0) +
    request.maxOutputTokens;
  for (let attempt = 1; ; attempt += 1) {
    if (!deps.breaker.allow()) throw new StopTurn('provider_unavailable');
    const reservation = await deps.budget.reserve(estimate);
    if (reservation === null) {
      deps.breaker.released();
      throw new StopTurn('budget_exhausted');
    }
    const routed: LlmRequest = {
      ...request,
      route: routeFor({
        step: context.step,
        invalidCalls: context.invalidCalls,
        budget: reservation.state,
      }),
    };
    const remaining = context.deadline - deps.tools.clock.now().getTime();
    if (remaining <= 0) {
      deps.breaker.released();
      await reservation.settle(0);
      throw new StopTurn('time_limit');
    }
    const timeout = AbortSignal.timeout(Math.min(remaining, limits.callMs));
    const signal =
      context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
    const span = context.span.modelCall({ route: routed.route, step: context.step, attempt });
    let streamed = false;
    // No web address reaches the screen or the conversation, streamed or stored (links.ts).
    const scrubber = new LinkScrubber();
    try {
      let response: LlmResponse | undefined;
      for await (const event of provider.stream(routed, { signal })) {
        const delta = event.type === 'text_delta' ? scrubber.push(event.delta) : scrubber.flush();
        if (delta !== '') {
          streamed = true;
          await context.send({ type: 'text.delta', delta: delta.slice(0, 4_000) });
        }
        if (event.type === 'done') response = event.response;
      }
      if (response === undefined)
        throw new LlmError('invalid_response', 'The stream ended without an answer');
      response = { ...response, text: withoutLinks(response.text) };
      await reservation.settle(response.usage.inputTokens + response.usage.outputTokens);
      deps.breaker.succeeded();
      span.end({ response });
      return response;
    } catch (error) {
      const llm = isLlmError(error)
        ? error
        : new LlmError('invalid_response', 'The provider failed');
      const billed = llm.usage === undefined ? 0 : llm.usage.inputTokens + llm.usage.outputTokens;
      await reservation.settle(billed);
      span.fail(llm.code);
      if (context.signal?.aborted === true) {
        deps.breaker.released();
        throw new StopTurn('cancelled');
      }
      if (timeout.aborted || llm.code === 'aborted') {
        // Our own time limit: the provider was too slow, which counts against it.
        deps.breaker.failed();
        if (deps.tools.clock.now().getTime() >= context.deadline) throw new StopTurn('time_limit');
      } else if (llm.code === 'bad_request' || llm.code === 'auth') {
        deps.breaker.released();
      } else {
        deps.breaker.failed();
      }
      const retryable = llm.retryable && !streamed && attempt < 2;
      if (!retryable) throw new StopTurn('provider_unavailable');
      await sleep(250 + Math.floor(Math.random() * 250));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunContext {
  dispatch: typeof dispatchToolCall;
  deps: AgentDeps;
  limits: LoopLimits;
  deadline: number;
  toolTurn: () => ToolTurn;
  send: (event: ChatEvent) => Promise<void>;
  span: TurnSpan;
}

/**
 * Runs one answer's tool calls: reads at the same time (up to `readConcurrency`), then writes
 * one at a time in the model's order, each seeing the turn's untrusted flag as it stands.
 * Returns the outcomes in call order.
 */
async function runCalls(
  run: RunContext,
  calls: readonly LlmToolCall[],
  writes: () => number,
  wrote: () => void,
): Promise<Step> {
  const outcomes: ToolOutcome[] = new Array<ToolOutcome>(calls.length);
  const seen = new Set<string>();
  const reads: number[] = [];
  const writesInOrder: number[] = [];
  calls.forEach((call, index) => {
    if (index >= run.limits.maxCallsPerStep) {
      outcomes[index] = refusedHere(
        call.name,
        'turn_limit',
        'Too many tool calls at once; make fewer and try again.',
      );
      return;
    }
    if (seen.has(call.id)) {
      outcomes[index] = refusedHere(
        call.name,
        'invalid_arguments',
        'This call id was used twice in one answer; give each call its own id.',
      );
      return;
    }
    seen.add(call.id);
    (findTool(call.name)?.kind === 'write' ? writesInOrder : reads).push(index);
  });

  const runOne = async (index: number): Promise<void> => {
    const call = calls[index];
    if (call === undefined) return;
    await run.send({ type: 'tool.started', tool: toolName(call.name), step: run.toolTurn().step });
    const span = run.span.toolCall({ tool: toolName(call.name), step: run.toolTurn().step });
    const outcome = await run.dispatch(run.deps.tools, run.toolTurn(), call);
    span.end({ status: outcome.status, code: outcome.status === 'refused' ? outcome.code : null });
    outcomes[index] = outcome;
    await run.send({
      type: 'tool.finished',
      tool: toolName(call.name),
      status: outcome.status,
      summary:
        outcome.status === 'refused'
          ? outcome.message.slice(0, 600)
          : outcome.summary.slice(0, 600),
      code: outcome.status === 'refused' ? outcome.code : null,
      card: outcome.card,
    });
  };

  const queue = [...reads];
  await Promise.all(
    Array.from({ length: Math.min(run.limits.readConcurrency, queue.length) }, async () => {
      for (let index = queue.shift(); index !== undefined; index = queue.shift()) {
        await runOne(index);
      }
    }),
  );
  for (const index of writesInOrder) {
    const call = calls[index];
    if (call === undefined) continue;
    if (writes() >= run.limits.maxWrites) {
      outcomes[index] = refusedHere(
        call.name,
        'turn_limit',
        `One turn makes at most ${String(run.limits.maxWrites)} changes. Tell the member what is done and ask them to continue.`,
      );
      continue;
    }
    if (run.deps.tools.clock.now().getTime() >= run.deadline) {
      outcomes[index] = refusedHere(
        call.name,
        'turn_limit',
        'Out of time for this turn; nothing changed. Ask the member to try again.',
      );
      continue;
    }
    wrote();
    await runOne(index);
  }
  return { outcomes };
}

/** The tool's own name, or `unknown_tool` for a made-up one (never the model's text). */
function toolName(name: string): string {
  return findTool(name)?.name ?? 'unknown_tool';
}

function refusedHere(name: string, code: ToolErrorCode, message: string): ToolOutcome {
  return {
    status: 'refused',
    tool: toolName(name),
    code,
    message,
    alternatives: [],
    card: null,
    error: null,
  };
}

function notRun(name: string, code: ToolErrorCode): ToolOutcome {
  return refusedHere(name, code, 'This call was not run; nothing changed.');
}

/**
 * Ends a turn whose server stopped mid-way (ADR-0030): for each tool call it recorded without a
 * result, it reads what the trust layer did with that call's key and records that, never calling
 * a tool again (a write found nowhere never ran, and does not run late). Then the turn ends as
 * `interrupted`. No model call.
 */
export async function recoverTurn(deps: AgentDeps, turn: TurnView): Promise<void> {
  const messages = await deps.store.turnMessages(turn.id);
  const answered = new Set(
    messages.filter((m) => m.role === 'tool').map((m) => `${String(m.step)}:${m.toolCallId ?? ''}`),
  );
  const results: TurnMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.step === null) continue;
    const step = message.step;
    for (const call of message.toolCalls) {
      if (answered.has(`${String(step)}:${call.id}`)) continue;
      answered.add(`${String(step)}:${call.id}`);
      const tool = findTool(call.name);
      let content: string;
      let isError = false;
      if (tool?.kind === 'write') {
        const key = idempotencyKeyOf(
          { turnKey: turnKeyOf(turn), step, requestMessageId: null, untrustedContext: false },
          call.id,
        );
        const found = await deps.store.toolCallResult(key);
        if (found?.kind === 'executed') {
          content = JSON.stringify({
            status: 'done',
            note: 'Done before the interruption; the member sees it with Undo.',
          });
        } else if (found?.kind === 'proposed') {
          content = JSON.stringify({
            status: 'awaiting_approval',
            note: 'Waiting for the member’s OK on the card; nothing changed yet.',
          });
        } else {
          content = JSON.stringify({
            status: 'refused',
            code: 'internal',
            message: 'Not run (interrupted); nothing changed.',
          });
          isError = true;
        }
      } else {
        content = JSON.stringify({
          status: 'refused',
          code: 'internal',
          message: 'Not run (interrupted).',
        });
        isError = true;
      }
      results.push({
        role: 'tool',
        content,
        step,
        toolCallId: call.id,
        toolName: tool?.name ?? 'unknown_tool',
        isError,
        card: null,
        untrusted: false,
      });
    }
  }
  // The recorded progress stays (the tokens were metered when they were used).
  // Two requests may recover the same turn at once: the one that loses finds the results
  // recorded (unique per step and call) or the turn ended, and that is the same outcome.
  if (results.length > 0) await deps.store.record(turn, results, null).catch(() => undefined);
  await deps.store.end(turn.id, 'interrupted', null);
}
