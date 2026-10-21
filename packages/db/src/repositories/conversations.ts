import {
  ChatChannelSchema,
  ConversationIdSchema,
  ConversationMessageIdSchema,
  ConversationTurnIdSchema,
  LlmReplaySchema,
  LlmToolCallSchema,
  ToolCardSchema,
  TurnStopReasonSchema,
  type ChatChannel,
  type ConversationId,
  type ConversationMessageId,
  type ConversationTurnId,
  type LlmReplay,
  type LlmToolCall,
  type ToolCard,
  type TurnStatus,
  type TurnStopReason,
  type UserId,
} from '@pepper/contracts';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  conversationMessages,
  conversations,
  conversationTurns,
  type ConversationMessageRow,
  type ConversationRow,
  type ConversationTurnRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Conversations with the AI (ADR-0030), for the transaction's tenant. Run inside `withMember`
// for a member: the `member_scope` policies limit every role to its own conversations. What is
// stored is validated here against the contracts, and the database checks it again.

const Id = z.uuid();
const LimitSchema = z.number().int().min(1).max(1_000);
const StepSchema = z.int().min(1).max(99);
const TokensSchema = z.int().min(0).max(100_000_000);

/** Starts a conversation for `userId`. */
export async function insertConversation(
  tx: TenantTx,
  input: { userId: UserId; channel: ChatChannel },
): Promise<ConversationRow> {
  const [row] = await tx
    .insert(conversations)
    .values({ userId: Id.parse(input.userId), channel: ChatChannelSchema.parse(input.channel) })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- an insert of one row returns one row
  return row!;
}

/** The conversation with this id, if the transaction may see it; locked when asked. */
export async function findConversation(
  tx: TenantTx,
  id: ConversationId,
  options: { lock?: boolean } = {},
): Promise<ConversationRow | undefined> {
  const query = tx
    .select()
    .from(conversations)
    .where(eq(conversations.id, ConversationIdSchema.parse(id)));
  const [row] = await (options.lock === true ? query.for('update') : query);
  return row;
}

/** Marks the conversation as active at `at` (the newest first in the list; retention). */
export async function touchConversation(tx: TenantTx, id: ConversationId, at: Date): Promise<void> {
  await tx
    .update(conversations)
    .set({ lastMessageAt: at })
    .where(eq(conversations.id, ConversationIdSchema.parse(id)));
}

/** The member's conversations, most recently active first. */
export async function listConversations(
  tx: TenantTx,
  userId: UserId,
  limit: number,
): Promise<ConversationRow[]> {
  return tx
    .select()
    .from(conversations)
    .where(eq(conversations.userId, Id.parse(userId)))
    .orderBy(desc(conversations.lastMessageAt), desc(conversations.id))
    .limit(LimitSchema.parse(limit));
}

/**
 * Starts a running turn. Returns `undefined` when this member already has a turn with this
 * client id (a retried request) or the conversation already runs one: the caller looks those
 * up instead.
 */
export async function insertTurn(
  tx: TenantTx,
  input: {
    conversationId: ConversationId;
    userId: UserId;
    clientTurnId: string;
    /** When it started, on the app's clock (the turn's "now" and deadline come from it). */
    startedAt?: Date;
    deadlineAt: Date;
  },
): Promise<ConversationTurnRow | undefined> {
  const [row] = await tx
    .insert(conversationTurns)
    .values({
      conversationId: ConversationIdSchema.parse(input.conversationId),
      userId: Id.parse(input.userId),
      clientTurnId: Id.parse(input.clientTurnId),
      deadlineAt: input.deadlineAt,
      ...(input.startedAt !== undefined && { createdAt: input.startedAt }),
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** The member's turn with this client id, if any. */
export async function findTurnByClientId(
  tx: TenantTx,
  userId: UserId,
  clientTurnId: string,
): Promise<ConversationTurnRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.userId, Id.parse(userId)),
        eq(conversationTurns.clientTurnId, Id.parse(clientTurnId)),
      ),
    );
  return row;
}

/** The turn with this id, if the transaction may see it; locked when asked. */
export async function findTurn(
  tx: TenantTx,
  id: ConversationTurnId,
  options: { lock?: boolean } = {},
): Promise<ConversationTurnRow | undefined> {
  const query = tx
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.id, ConversationTurnIdSchema.parse(id)));
  const [row] = await (options.lock === true ? query.for('update') : query);
  return row;
}

/** The conversation's running turn, if any, locked until the transaction ends. */
export async function lockRunningTurn(
  tx: TenantTx,
  conversationId: ConversationId,
): Promise<ConversationTurnRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.conversationId, ConversationIdSchema.parse(conversationId)),
        eq(conversationTurns.status, 'running'),
      ),
    )
    .for('update');
  return row;
}

export interface TurnProgress {
  steps: number;
  untrusted: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

function progressValues(progress: TurnProgress) {
  return {
    steps: z.int().min(0).max(99).parse(progress.steps),
    untrusted: z.boolean().parse(progress.untrusted),
    inputTokens: TokensSchema.parse(progress.inputTokens),
    cachedInputTokens: TokensSchema.parse(progress.cachedInputTokens),
    outputTokens: TokensSchema.parse(progress.outputTokens),
  };
}

/** Records how far a running turn got. Returns `false` if it is no longer running. */
export async function saveTurnProgress(
  tx: TenantTx,
  id: ConversationTurnId,
  progress: TurnProgress,
): Promise<boolean> {
  const rows = await tx
    .update(conversationTurns)
    .set(progressValues(progress))
    .where(
      and(
        eq(conversationTurns.id, ConversationTurnIdSchema.parse(id)),
        eq(conversationTurns.status, 'running'),
      ),
    )
    .returning({ id: conversationTurns.id });
  return rows.length === 1;
}

/** Ends a running turn once, with its final progress (`null`: as recorded). `false` if it had ended. */
export async function finishTurn(
  tx: TenantTx,
  id: ConversationTurnId,
  input: {
    status: Exclude<TurnStatus, 'running'>;
    stopReason: TurnStopReason;
    at: Date;
    progress: TurnProgress | null;
  },
): Promise<boolean> {
  const rows = await tx
    .update(conversationTurns)
    .set({
      ...(input.progress === null ? {} : progressValues(input.progress)),
      status: z.enum(['completed', 'failed', 'cancelled']).parse(input.status),
      stopReason: TurnStopReasonSchema.parse(input.stopReason),
      finishedAt: input.at,
    })
    .where(
      and(
        eq(conversationTurns.id, ConversationTurnIdSchema.parse(id)),
        eq(conversationTurns.status, 'running'),
      ),
    )
    .returning({ id: conversationTurns.id });
  return rows.length === 1;
}

export type NewConversationMessage = {
  conversationId: ConversationId;
  turnId: ConversationTurnId;
  userId: UserId;
  content: string;
  untrusted: boolean;
} & (
  | { role: 'user' }
  | { role: 'assistant'; step: number; toolCalls: LlmToolCall[]; replay: LlmReplay }
  | {
      role: 'tool';
      step: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      card: ToolCard | null;
    }
);

/**
 * Appends a message at the end of its conversation (the next `seq`). Only the conversation's
 * one running turn adds messages, so the sequence has no gaps or races; the unique key would
 * refuse one anyway.
 */
export async function insertMessage(
  tx: TenantTx,
  input: NewConversationMessage,
): Promise<ConversationMessageRow> {
  const conversationId = ConversationIdSchema.parse(input.conversationId);
  const nextSeq = sql<number>`(SELECT COALESCE(MAX(${conversationMessages.seq}), 0) + 1 FROM ${conversationMessages} WHERE ${conversationMessages.conversationId} = ${conversationId})`;
  const [row] = await tx
    .insert(conversationMessages)
    .values({
      conversationId,
      turnId: ConversationTurnIdSchema.parse(input.turnId),
      userId: Id.parse(input.userId),
      seq: nextSeq,
      role: input.role,
      content: z.string().max(100_000).parse(input.content),
      untrusted: z.boolean().parse(input.untrusted),
      ...(input.role === 'assistant' && {
        step: StepSchema.parse(input.step),
        toolCalls: z.array(LlmToolCallSchema).max(32).parse(input.toolCalls),
        replay: LlmReplaySchema.parse(input.replay),
      }),
      ...(input.role === 'tool' && {
        step: StepSchema.parse(input.step),
        toolCallId: z.string().min(1).max(200).parse(input.toolCallId),
        toolName: z
          .string()
          .regex(/^[a-z][a-z0-9_]{0,63}$/)
          .parse(input.toolName),
        isError: z.boolean().parse(input.isError),
        card: input.card === null ? null : ToolCardSchema.parse(input.card),
      }),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- an insert of one row returns one row
  return row!;
}

/** The conversation's newest `limit` messages, oldest first. */
export async function listRecentMessages(
  tx: TenantTx,
  conversationId: ConversationId,
  limit: number,
): Promise<ConversationMessageRow[]> {
  const rows = await tx
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.conversationId, ConversationIdSchema.parse(conversationId)))
    .orderBy(desc(conversationMessages.seq))
    .limit(LimitSchema.parse(limit));
  return rows.reverse();
}

/** One turn's messages, in order. */
export async function listTurnMessages(
  tx: TenantTx,
  turnId: ConversationTurnId,
): Promise<ConversationMessageRow[]> {
  return tx
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.turnId, ConversationTurnIdSchema.parse(turnId)))
    .orderBy(asc(conversationMessages.seq));
}

/** The message with this id, if the transaction may see it. */
export async function findMessage(
  tx: TenantTx,
  id: ConversationMessageId,
): Promise<ConversationMessageRow | undefined> {
  const [row] = await tx
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.id, ConversationMessageIdSchema.parse(id)));
  return row;
}

/**
 * Deletes up to `limit` of the transaction's tenant's conversations whose last message is
 * older than `before`, with their turns and messages (the clean-up, ADR-0030). A conversation
 * with a running turn is left for the next pass. Returns how many it deleted.
 */
export async function deleteIdleConversations(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const running = tx
    .select({ id: conversationTurns.conversationId })
    .from(conversationTurns)
    .where(eq(conversationTurns.status, 'running'));
  const batch = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(lt(conversations.lastMessageAt, before), sql`${conversations.id} NOT IN (${running})`),
    )
    .limit(LimitSchema.parse(limit));
  const deleted = await tx
    .delete(conversations)
    .where(inArray(conversations.id, batch))
    .returning({ id: conversations.id });
  return deleted.length;
}
