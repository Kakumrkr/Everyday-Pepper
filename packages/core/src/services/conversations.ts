import {
  ConversationIdSchema,
  ConversationMessageIdSchema,
  ConversationTurnIdSchema,
  LlmReplaySchema,
  ChatTurnRequestSchema,
  LlmAssistantMessageSchema,
  ToolCardSchema,
  TurnStatusSchema,
  TurnStopReasonSchema,
  UtcDateTimeSchema,
  type ChatChannel,
  type ChatHistoryItem,
  type ConversationId,
  type ConversationMessageId,
  type ConversationSummary,
  type ConversationTurnId,
  type LlmReplay,
  type LlmToolCall,
  type ToolCard,
  type TurnStatus,
  type TurnStopReason,
} from '@pepper/contracts';
import {
  deleteIdleConversations,
  findConversation,
  findTurn,
  findTurnByClientId,
  finishTurn,
  insertConversation,
  insertMessage,
  insertTurn,
  listConversations,
  listRecentMessages,
  listTurnMessages,
  lockRunningTurn,
  saveTurnProgress,
  touchConversation,
  withMember,
  type ConversationMessageRow,
  type ConversationTurnRow,
  type Database,
  type TenantTx,
  type TurnProgress,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { ConversationNotFoundError } from '../errors.js';

// A member's conversations with the AI (ADR-0030). Every role reaches only its own (the
// database's member scope says the same): a chat is personal, and leads oversee the AI through
// its proposals and receipts instead. The agent loop (`@pepper/ai`) records each turn here
// step by step, before it acts, so a retried request or a server that stopped mid-turn never
// runs anything twice. No model is ever called inside these transactions.

/** How long after a running turn's deadline it counts as abandoned (its server stopped). */
export const STALE_TURN_GRACE_MS = 30_000;
/** How long a conversation is kept after its last message. */
export const CONVERSATION_RETENTION_MS = 90 * 24 * 60 * 60_000;

/** A message as stored: exactly what the model was sent, plus the card the member saw. */
export interface StoredMessage {
  id: ConversationMessageId;
  turnId: ConversationTurnId;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls: LlmToolCall[];
  replay: LlmReplay;
  toolCallId: string | null;
  toolName: string | null;
  isError: boolean;
  card: ToolCard | null;
  step: number | null;
  /** Text from outside the team, or an answer written after it: labelled when re-sent. */
  untrusted: boolean;
  createdAt: Date;
}

export interface TurnView {
  id: ConversationTurnId;
  conversationId: ConversationId;
  status: TurnStatus;
  stopReason: TurnStopReason | null;
  untrusted: boolean;
  steps: number;
  deadlineAt: Date;
  startedAt: Date;
}

export type BeginTurnResult =
  | {
      kind: 'started';
      turn: TurnView;
      requestMessageId: ConversationMessageId;
    }
  /** The same client turn id again (a retry, another tab): that turn, never a second run. */
  | { kind: 'existing'; turn: TurnView }
  /** The conversation is answering another message. */
  | { kind: 'busy'; turn: TurnView }
  /** The conversation's running turn was abandoned: recover it (`@pepper/ai`), then retry. */
  | { kind: 'stale'; turn: TurnView };

/**
 * Starts a turn with the member's message, in a new conversation when `conversationId` is
 * `null`. `deadlineAt` bounds the turn (the loop's wall-clock limit).
 */
export async function beginTurn(
  db: Database,
  actor: Actor,
  input: {
    clientTurnId: string;
    conversationId: ConversationId | null;
    message: string;
    channel: ChatChannel;
    deadlineAt: Date;
    now: Date;
  },
): Promise<BeginTurnResult> {
  requirePermission(actor, 'ai.chat');
  const userId = actor.context.userId;
  const clientTurnId = ChatTurnRequestSchema.shape.clientTurnId.parse(input.clientTurnId);
  const started = await withMember(
    db,
    actor.context,
    async (tx): Promise<BeginTurnResult | null> => {
      const again = await findTurnByClientId(tx, userId, clientTurnId);
      if (again !== undefined) return { kind: 'existing', turn: toTurn(again) };

      let conversationId: ConversationId;
      if (input.conversationId === null) {
        const created = await insertConversation(tx, { userId, channel: input.channel });
        conversationId = ConversationIdSchema.parse(created.id);
      } else {
        const found = await findConversation(tx, input.conversationId, { lock: true });
        if (found === undefined) throw new ConversationNotFoundError();
        conversationId = ConversationIdSchema.parse(found.id);
        const running = await lockRunningTurn(tx, conversationId);
        if (running !== undefined) {
          const stale = running.deadlineAt.getTime() + STALE_TURN_GRACE_MS < input.now.getTime();
          return { kind: stale ? 'stale' : 'busy', turn: toTurn(running) };
        }
      }
      const row = await insertTurn(tx, {
        conversationId,
        userId,
        clientTurnId,
        startedAt: input.now,
        deadlineAt: input.deadlineAt,
      });
      // A copy of this request (same client turn id) got there first: answer with its turn, in a
      // fresh read after this transaction rolls back (so no empty conversation is left behind).
      if (row === undefined) throw new LostTurnRace();
      const turn = toTurn(row);
      const message = await insertMessage(tx, {
        conversationId,
        turnId: turn.id,
        userId,
        role: 'user',
        content: input.message,
        untrusted: false,
      });
      await touchConversation(tx, conversationId, input.now);
      return {
        kind: 'started',
        turn,
        requestMessageId: ConversationMessageIdSchema.parse(message.id),
      };
    },
  ).catch((error: unknown) => {
    if (error instanceof LostTurnRace) return null;
    throw error;
  });
  if (started !== null) return started;
  const winner = await withMember(db, actor.context, (tx) =>
    findTurnByClientId(tx, userId, clientTurnId),
  );
  if (winner === undefined) throw new Error('beginTurn: the turn was neither created nor found');
  return { kind: 'existing', turn: toTurn(winner) };
}

/** Another copy of the request created the turn first (unique client turn id). */
class LostTurnRace extends Error {}

/** The member's turn, or `ConversationNotFoundError`. */
export async function getTurn(
  db: Database,
  actor: Actor,
  turnId: ConversationTurnId,
): Promise<TurnView> {
  requirePermission(actor, 'ai.chat');
  const row = await withMember(db, actor.context, (tx) => findTurn(tx, turnId));
  if (row === undefined) throw new ConversationNotFoundError();
  return toTurn(row);
}

/** The newest `limit` messages of the member's conversation, oldest first. */
export async function recentMessages(
  db: Database,
  actor: Actor,
  conversationId: ConversationId,
  limit: number,
): Promise<StoredMessage[]> {
  requirePermission(actor, 'ai.chat');
  const rows = await withMember(db, actor.context, (tx) =>
    listRecentMessages(tx, conversationId, limit),
  );
  return rows.map(toMessage);
}

/** One turn's messages, in order (recovery of an abandoned turn). */
export async function turnMessages(
  db: Database,
  actor: Actor,
  turnId: ConversationTurnId,
): Promise<StoredMessage[]> {
  requirePermission(actor, 'ai.chat');
  const rows = await withMember(db, actor.context, (tx) => listTurnMessages(tx, turnId));
  return rows.map(toMessage);
}

/** A message the loop records into its running turn (the member's is recorded by `beginTurn`). */
export type TurnMessage =
  | {
      role: 'assistant';
      content: string;
      step: number;
      toolCalls: LlmToolCall[];
      replay: LlmReplay;
      untrusted: boolean;
    }
  | {
      role: 'tool';
      content: string;
      step: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      card: ToolCard | null;
      untrusted: boolean;
    };

/**
 * Records messages into the member's running turn, in order, with its progress (`null`: leave
 * it), in one short transaction. The database refuses a message once the turn ended.
 */
export async function recordTurnMessages(
  db: Database,
  actor: Actor,
  turn: Pick<TurnView, 'id' | 'conversationId'>,
  messages: readonly TurnMessage[],
  progress: TurnProgress | null,
  now: Date,
): Promise<StoredMessage[]> {
  requirePermission(actor, 'ai.chat');
  return withMember(db, actor.context, async (tx) => {
    const stored: StoredMessage[] = [];
    for (const message of messages) {
      const row = await insertMessage(tx, {
        ...message,
        conversationId: turn.conversationId,
        turnId: turn.id,
        userId: actor.context.userId,
      });
      stored.push(toMessage(row));
    }
    if (progress !== null) await saveTurnProgress(tx, turn.id, progress);
    await touchConversation(tx, turn.conversationId, now);
    return stored;
  });
}

/** Ends the member's running turn once (`progress` `null`: as recorded); `false` if it had ended. */
export async function endTurn(
  db: Database,
  actor: Actor,
  turnId: ConversationTurnId,
  input: { reason: TurnStopReason; progress: TurnProgress | null; now: Date },
): Promise<boolean> {
  requirePermission(actor, 'ai.chat');
  const status: Exclude<TurnStatus, 'running'> =
    input.reason === 'answered'
      ? 'completed'
      : input.reason === 'cancelled'
        ? 'cancelled'
        : 'failed';
  return withMember(db, actor.context, (tx) =>
    finishTurn(tx, turnId, {
      status,
      stopReason: input.reason,
      at: input.now,
      progress: input.progress,
    }),
  );
}

/** The member's conversations, most recently active first. */
export async function listMyConversations(
  db: Database,
  actor: Actor,
  limit = 50,
): Promise<ConversationSummary[]> {
  requirePermission(actor, 'ai.chat');
  const rows = await withMember(db, actor.context, (tx) =>
    listConversations(tx, actor.context.userId, limit),
  );
  return rows.map((row) => ({
    id: ConversationIdSchema.parse(row.id),
    channel: row.channel === 'voice' ? 'voice' : 'chat',
    lastMessageAt: UtcDateTimeSchema.parse(row.lastMessageAt.toISOString()),
  }));
}

/**
 * The member's conversation as they see it (S26 history): their words, the AI's answers and
 * the cards, newest `limit` messages. Tool results' raw text stays with the model.
 */
export async function conversationHistory(
  db: Database,
  actor: Actor,
  conversationId: ConversationId,
  limit = 200,
): Promise<ChatHistoryItem[]> {
  requirePermission(actor, 'ai.chat');
  const rows = await withMember(db, actor.context, async (tx) => {
    if ((await findConversation(tx, conversationId)) === undefined) {
      throw new ConversationNotFoundError();
    }
    return listRecentMessages(tx, conversationId, limit);
  });
  const items: ChatHistoryItem[] = [];
  for (const message of rows.map(toMessage)) {
    const createdAt = UtcDateTimeSchema.parse(message.createdAt.toISOString());
    if (message.role === 'user') {
      items.push({ kind: 'user', id: message.id, text: message.content, createdAt });
    } else if (message.role === 'assistant') {
      if (message.content !== '') {
        items.push({ kind: 'assistant', id: message.id, text: message.content, createdAt });
      }
    } else {
      items.push({
        kind: 'tool',
        id: message.id,
        tool: message.toolName ?? 'unknown',
        card: message.card,
        createdAt,
      });
    }
  }
  return items;
}

/** The clean-up's part (ADR-0030): idle conversations go after their retention. */
export function deleteIdleConversationsIn(tx: TenantTx, now: Date, limit: number): Promise<number> {
  return deleteIdleConversations(tx, new Date(now.getTime() - CONVERSATION_RETENTION_MS), limit);
}

function toTurn(row: ConversationTurnRow): TurnView {
  return {
    id: ConversationTurnIdSchema.parse(row.id),
    conversationId: ConversationIdSchema.parse(row.conversationId),
    status: TurnStatusSchema.parse(row.status),
    stopReason: row.stopReason === null ? null : TurnStopReasonSchema.parse(row.stopReason),
    untrusted: row.untrusted,
    steps: row.steps,
    deadlineAt: row.deadlineAt,
    startedAt: row.createdAt,
  };
}

function roleOf(role: string): StoredMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role;
  throw new Error(`Unknown message role: ${role}`);
}

function toMessage(row: ConversationMessageRow): StoredMessage {
  return {
    id: ConversationMessageIdSchema.parse(row.id),
    turnId: ConversationTurnIdSchema.parse(row.turnId),
    seq: row.seq,
    role: roleOf(row.role),
    content: row.content,
    toolCalls: LlmAssistantMessageSchema.shape.toolCalls.parse(row.toolCalls),
    replay: LlmReplaySchema.parse(row.replay),
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    isError: row.isError,
    card: row.card === null ? null : ToolCardSchema.parse(row.card),
    step: row.step,
    untrusted: row.untrusted,
    createdAt: row.createdAt,
  };
}

export type { TurnProgress };
