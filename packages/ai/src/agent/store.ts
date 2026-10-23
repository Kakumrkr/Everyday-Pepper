import {
  ConversationMessageIdSchema,
  type ActionExecution,
  type ActionProposal,
  type ChatChannel,
  type ConversationId,
  type ConversationTurnId,
  type TurnStopReason,
} from '@pepper/contracts';
import {
  beginTurn,
  endTurn,
  findToolCallResult,
  recentMessages,
  recordTurnMessages,
  turnMessages,
  type Actor,
  type BeginTurnResult,
  type Clock,
  type StoredMessage,
  type TurnMessage,
  type TurnProgress,
  type TurnView,
} from '@pepper/core';
import type { Database } from '@pepper/db';

// Where the loop keeps a conversation (ADR-0030): a port, so the loop's unit tests run on
// memory and the app on Postgres (`@pepper/core`'s conversation services, as the member).
// Every call is its own short transaction; none is open while the model is called.

export type ToolCallResult =
  | { kind: 'executed'; execution: ActionExecution }
  | { kind: 'proposed'; proposal: ActionProposal }
  | null;

export interface ConversationStore {
  begin(input: {
    clientTurnId: string;
    conversationId: ConversationId | null;
    message: string;
    channel: ChatChannel;
    deadlineAt: Date;
    now: Date;
  }): Promise<BeginTurnResult>;
  /** The conversation's newest `limit` messages, oldest first. */
  history(conversationId: ConversationId, limit: number): Promise<StoredMessage[]>;
  /** One turn's messages, in order. */
  turnMessages(turnId: ConversationTurnId): Promise<StoredMessage[]>;
  record(
    turn: Pick<TurnView, 'id' | 'conversationId'>,
    messages: readonly TurnMessage[],
    /** `null`: leave the turn's progress as recorded. */
    progress: TurnProgress | null,
  ): Promise<StoredMessage[]>;
  end(
    turnId: ConversationTurnId,
    reason: TurnStopReason,
    progress: TurnProgress | null,
  ): Promise<boolean>;
  /** What a write with this idempotency key came to (recovery). */
  toolCallResult(idempotencyKey: string): Promise<ToolCallResult>;
}

/**
 * The store on Postgres, as the member in `actor`. With `episodeKey` (the outbox key, when the
 * app writes episodes, S31) every turn that ends queues its conversation's episode.
 */
export function postgresConversationStore(
  db: Database,
  actor: Actor,
  clock: Clock,
  options: { episodeKey?: Buffer } = {},
): ConversationStore {
  const episodes =
    options.episodeKey === undefined ? {} : { episodes: { key: options.episodeKey } };
  return {
    begin: (input) => beginTurn(db, actor, input),
    history: (conversationId, limit) => recentMessages(db, actor, conversationId, limit),
    turnMessages: (turnId) => turnMessages(db, actor, turnId),
    record: (turn, messages, progress) =>
      recordTurnMessages(db, actor, turn, messages, progress, clock.now()),
    end: (turnId, reason, progress) =>
      endTurn(db, actor, turnId, { reason, progress, now: clock.now(), ...episodes }),
    toolCallResult: (key) => findToolCallResult(db, actor, key),
  };
}

/**
 * A store in memory with the same rules as the database (one running turn per conversation,
 * a client turn id runs once, messages only into a running turn), for the loop's unit tests.
 */
export class MemoryConversationStore implements ConversationStore {
  readonly turns = new Map<string, TurnView & { clientTurnId: string; progress: TurnProgress }>();
  readonly messages: StoredMessage[] = [];
  readonly results = new Map<string, NonNullable<ToolCallResult>>();
  private ids = 0;

  private id(): string {
    this.ids += 1;
    return `0199f4b2-7c1e-7a00-8000-${String(this.ids).padStart(12, '0')}`;
  }

  begin(input: Parameters<ConversationStore['begin']>[0]): Promise<BeginTurnResult> {
    const again = [...this.turns.values()].find((turn) => turn.clientTurnId === input.clientTurnId);
    if (again !== undefined) return Promise.resolve({ kind: 'existing', turn: view(again) });
    const conversationId = (input.conversationId ?? this.id()) as ConversationId;
    const running = [...this.turns.values()].find(
      (turn) => turn.conversationId === conversationId && turn.status === 'running',
    );
    if (running !== undefined) {
      const stale = running.deadlineAt.getTime() + 30_000 < input.now.getTime();
      return Promise.resolve({ kind: stale ? 'stale' : 'busy', turn: view(running) });
    }
    const turn = {
      id: this.id() as ConversationTurnId,
      conversationId,
      clientTurnId: input.clientTurnId,
      status: 'running' as const,
      stopReason: null,
      untrusted: false,
      steps: 0,
      deadlineAt: input.deadlineAt,
      startedAt: input.now,
      progress: {
        steps: 0,
        untrusted: false,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
      },
    };
    this.turns.set(turn.id, turn);
    const [message] = this.add(turn, [{ role: 'user', content: input.message, untrusted: false }]);
    return Promise.resolve({
      kind: 'started',
      turn: view(turn),
      requestMessageId: ConversationMessageIdSchema.parse(message?.id),
    });
  }

  history(conversationId: ConversationId, limit: number): Promise<StoredMessage[]> {
    const turnsOf = new Set(
      [...this.turns.values()].filter((t) => t.conversationId === conversationId).map((t) => t.id),
    );
    return Promise.resolve(this.messages.filter((m) => turnsOf.has(m.turnId)).slice(-limit));
  }

  turnMessages(turnId: ConversationTurnId): Promise<StoredMessage[]> {
    return Promise.resolve(this.messages.filter((m) => m.turnId === turnId));
  }

  record(
    turn: Pick<TurnView, 'id' | 'conversationId'>,
    messages: readonly TurnMessage[],
    progress: TurnProgress | null,
  ): Promise<StoredMessage[]> {
    const stored = this.turns.get(turn.id);
    if (stored?.status !== 'running') return Promise.reject(new Error('The turn is not running'));
    if (progress !== null) stored.progress = progress;
    return Promise.resolve(this.add(stored, messages));
  }

  end(
    turnId: ConversationTurnId,
    reason: TurnStopReason,
    progress: TurnProgress | null,
  ): Promise<boolean> {
    const turn = this.turns.get(turnId);
    if (turn?.status !== 'running') return Promise.resolve(false);
    turn.status =
      reason === 'answered' ? 'completed' : reason === 'cancelled' ? 'cancelled' : 'failed';
    turn.stopReason = reason;
    if (progress !== null) turn.progress = progress;
    turn.untrusted = turn.progress.untrusted;
    turn.steps = turn.progress.steps;
    return Promise.resolve(true);
  }

  toolCallResult(idempotencyKey: string): Promise<ToolCallResult> {
    return Promise.resolve(this.results.get(idempotencyKey) ?? null);
  }

  private add(
    turn: Pick<TurnView, 'id'>,
    messages: readonly (TurnMessage | { role: 'user'; content: string; untrusted: boolean })[],
  ): StoredMessage[] {
    return messages.map((message) => {
      const stored: StoredMessage = {
        id: this.id() as StoredMessage['id'],
        turnId: turn.id,
        seq: this.messages.length + 1,
        role: message.role,
        content: message.content,
        toolCalls: message.role === 'assistant' ? message.toolCalls : [],
        replay: message.role === 'assistant' ? message.replay : [],
        toolCallId: message.role === 'tool' ? message.toolCallId : null,
        toolName: message.role === 'tool' ? message.toolName : null,
        isError: message.role === 'tool' ? message.isError : false,
        card: message.role === 'tool' ? message.card : null,
        step: message.role === 'user' ? null : message.step,
        untrusted: message.untrusted,
        createdAt: new Date(),
      };
      this.messages.push(stored);
      return stored;
    });
  }
}

function view(turn: TurnView): TurnView {
  return {
    id: turn.id,
    conversationId: turn.conversationId,
    status: turn.status,
    stopReason: turn.stopReason,
    untrusted: turn.untrusted,
    steps: turn.steps,
    deadlineAt: turn.deadlineAt,
    startedAt: turn.startedAt,
  };
}
