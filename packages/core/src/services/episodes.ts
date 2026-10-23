import {
  ClientIdSchema,
  ConversationIdSchema,
  ConversationTurnIdSchema,
  MEMORY_LIMITS,
  MemoryEpisodeIdSchema,
  MemoryEpisodeInputSchema,
  MemoryFactIdSchema,
  OutboxDedupeKeySchema,
  OutboxEpisodeSchema,
  OutboxMessageIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type ClientId,
  type ConversationId,
  type ConversationTurnId,
  type MemoryEpisodeInput,
  type MemoryFactId,
  type OutboxEpisode,
  type OutboxMessageId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  countMemoryEpisodesOf,
  deleteMemoryEpisode,
  findClientsByIds,
  findConversation,
  findEpisodeOfConversation,
  findLatestTurn,
  insertMemoryEpisode,
  insertOutboxMessage,
  listRecentMessages,
  lockRememberedFacts,
  memoryPaused,
  newId,
  withMember,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { MemoryLimitError } from '../errors.js';
import { sealOutboxContent } from '../outbox.js';

// Episodes (S31, ADR-0037, playbook D-9): a short summary of each conversation, written by the
// worker once the conversation has been quiet for `MEMORY_LIMITS.episodeDelayMinutes`, for the
// AI's `search_memory`. A turn that ends queues the job in its own transaction (the outbox), so
// it runs if and only if the turn was recorded. Here: queueing it, reading what the summary is
// made from, and storing the summary. The model and the embedding are `@pepper/ai`'s.
//
// Forget must reach episodes (ADR-0036): an episode records the facts its conversation saved
// or recalled, and forgetting one deletes it (migration 0042). Storing locks those facts, so a
// forget either finds the stored episode or happened before, and then the job reads again.

/** How long a conversation is quiet before its episode is written. */
export const EPISODE_DELAY_MS = MEMORY_LIMITS.episodeDelayMinutes * 60_000;

/** The newest messages a summary is made from. */
export const EPISODE_SOURCE_MESSAGES = 120;

/** The most characters of conversation one summary reads (oldest dropped first). */
export const EPISODE_SOURCE_CHARS = 24_000;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Facts named in tool answers: recalled (`{"$fact": id}`) or saved (`"factId": id`). */
const FACT_REF =
  /"(?:\$fact|factId)":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** The episode job's last check failed: the conversation changed while it was summarised. */
export class EpisodeSourceChangedError extends Error {
  override readonly name = 'EpisodeSourceChangedError';
  constructor() {
    super('A fact the conversation named was forgotten while its episode was written');
  }
}

/** The conversation is not quiet yet: the job runs again at `until`. */
export class EpisodeNotQuietError extends Error {
  override readonly name = 'EpisodeNotQuietError';
  constructor(readonly until: Date) {
    super('The conversation is not quiet yet');
  }
}

/**
 * Queues the episode of the conversation a turn just ended in (in the turn's transaction),
 * due when the conversation has been quiet long enough. Every turn queues its own; the job of
 * an older turn finds a newer one and does nothing. Nothing while the business paused
 * remembering. Ids only, sealed like every outbox message.
 */
export async function queueEpisodeIn(
  tx: TenantTx,
  job: OutboxEpisode,
  options: { key: Buffer; now: Date },
): Promise<OutboxMessageId | undefined> {
  if (await memoryPaused(tx)) return undefined;
  const content = OutboxEpisodeSchema.parse(job);
  const id = OutboxMessageIdSchema.parse(newId());
  const row = await insertOutboxMessage(tx, {
    id,
    type: 'episode',
    dedupeKey: OutboxDedupeKeySchema.parse(`episode:${content.turnId}`),
    payload: sealOutboxContent(options.key, id, Buffer.from(JSON.stringify(content))),
    availableAt: new Date(options.now.getTime() + EPISODE_DELAY_MS),
  });
  return row === undefined ? undefined : id;
}

/** One line of the conversation as the summariser reads it. */
export interface EpisodeLine {
  who: 'member' | 'pepper';
  text: string;
  /** Words from outside the team, or an answer written after them. */
  untrusted: boolean;
}

export type EpisodeSource =
  /** Nothing to write: the chat is gone, a newer turn has its own job, paused, or done. */
  | { kind: 'skip'; reason: 'gone' | 'superseded' | 'paused' | 'written' }
  | {
      kind: 'ready';
      member: { tenantId: TenantId; userId: UserId };
      conversationId: ConversationId;
      turnId: ConversationTurnId;
      lines: EpisodeLine[];
      /** The facts it saved or recalled that are still remembered. */
      factIds: MemoryFactId[];
      /** The clients its tools answered about that still exist. */
      clientIds: ClientId[];
    };

/**
 * What the episode of `job`'s conversation is made from, as its member (own conversations
 * only): the member's words and the AI's answers, newest last, and the facts and clients it
 * named. `EpisodeNotQuietError` when the conversation's last turn is running or ended too
 * recently.
 */
export async function episodeSource(
  db: Database,
  tenantId: TenantId,
  job: OutboxEpisode,
  now: Date,
): Promise<EpisodeSource> {
  const content = OutboxEpisodeSchema.parse(job);
  const member = {
    tenantId: TenantIdSchema.parse(tenantId),
    userId: UserIdSchema.parse(content.userId),
  };
  const conversationId = ConversationIdSchema.parse(content.conversationId);
  const turnId = ConversationTurnIdSchema.parse(content.turnId);
  return withMember(db, member, async (tx): Promise<EpisodeSource> => {
    if ((await findConversation(tx, conversationId)) === undefined) {
      return { kind: 'skip', reason: 'gone' };
    }
    const latest = await findLatestTurn(tx, conversationId);
    if (latest?.id !== turnId) return { kind: 'skip', reason: 'superseded' };
    if (latest.finishedAt === null) throw new EpisodeNotQuietError(latest.deadlineAt);
    const quietAt = new Date(latest.finishedAt.getTime() + EPISODE_DELAY_MS);
    if (quietAt.getTime() > now.getTime()) throw new EpisodeNotQuietError(quietAt);
    if (await memoryPaused(tx)) return { kind: 'skip', reason: 'paused' };
    if ((await findEpisodeOfConversation(tx, conversationId))?.lastTurnId === turnId) {
      return { kind: 'skip', reason: 'written' };
    }

    const rows = await listRecentMessages(tx, conversationId, EPISODE_SOURCE_MESSAGES);
    const lines: EpisodeLine[] = [];
    const factIds = new Set<string>();
    const mentioned = new Set<string>();
    for (const row of rows) {
      if (row.role === 'tool') {
        for (const match of row.content.matchAll(FACT_REF)) {
          if (match[1] !== undefined) factIds.add(match[1].toLowerCase());
        }
        for (const id of row.content.match(UUID) ?? []) mentioned.add(id.toLowerCase());
        continue;
      }
      const text = row.content.trim();
      if (text === '') continue;
      lines.push({
        who: row.role === 'user' ? 'member' : 'pepper',
        text,
        untrusted: row.untrusted,
      });
    }
    let chars = 0;
    const kept: EpisodeLine[] = [];
    for (const line of [...lines].reverse()) {
      chars += line.text.length;
      if (chars > EPISODE_SOURCE_CHARS) break;
      kept.unshift(line);
    }
    const remembered = await lockRememberedFacts(
      tx,
      [...factIds].slice(0, 1000).map((id) => MemoryFactIdSchema.parse(id)),
    );
    const clients = await findClientsByIds(
      tx,
      [...mentioned].slice(0, 200).map((id) => ClientIdSchema.parse(id)),
    );
    return {
      kind: 'ready',
      member,
      conversationId,
      turnId,
      lines: kept,
      factIds: remembered.slice(0, MEMORY_LIMITS.episodeFactsMax),
      clientIds: clients
        .map((client) => ClientIdSchema.parse(client.id))
        .slice(0, MEMORY_LIMITS.episodeClientsMax),
    };
  });
}

/**
 * Stores a conversation's episode as its member, replacing the one it had (one per
 * conversation, S31 D-3). `written`: this turn's episode is already there (a retried job);
 * `paused`: the business paused remembering meanwhile. `EpisodeSourceChangedError` when a fact
 * it names was forgotten since it was read (the job reads the scrubbed chat again);
 * `MemoryLimitError` when the member has the most episodes kept.
 */
export async function storeEpisode(
  db: Database,
  member: { tenantId: TenantId; userId: UserId },
  input: MemoryEpisodeInput & { conversationId: ConversationId; lastTurnId: ConversationTurnId },
  options: { now: Date },
): Promise<'stored' | 'written' | 'paused'> {
  const fields = MemoryEpisodeInputSchema.parse(input);
  const conversationId = ConversationIdSchema.parse(input.conversationId);
  const userId = UserIdSchema.parse(member.userId);
  return withMember(db, member, async (tx) => {
    if (await memoryPaused(tx)) return 'paused';
    const existing = await findEpisodeOfConversation(tx, conversationId);
    if (existing?.lastTurnId === fields.lastTurnId) return 'written';
    // Locked until this transaction ends: a forget of one of them waits for the episode it must
    // delete. One already gone was forgotten after the chat was read: read it again.
    const wanted = [...new Set(fields.factIds)];
    if ((await lockRememberedFacts(tx, wanted)).length !== wanted.length) {
      throw new EpisodeSourceChangedError();
    }
    if (existing !== undefined) {
      await deleteMemoryEpisode(tx, MemoryEpisodeIdSchema.parse(existing.id));
    } else if ((await countMemoryEpisodesOf(tx, userId)) >= MEMORY_LIMITS.episodesPerMember) {
      throw new MemoryLimitError('episodes');
    }
    const row = await insertMemoryEpisode(tx, {
      ...fields,
      conversationId,
      userId,
      createdAt: options.now,
    });
    const entity = { type: 'memory_episode', id: row.id } as const;
    const after = { clientCount: row.clientIds.length };
    await appendAuditEntry(tx, {
      actor: { kind: 'system' },
      change:
        existing === undefined
          ? { action: 'memory_episode.created', entity, before: null, after }
          : {
              action: 'memory_episode.replaced',
              entity,
              before: { clientCount: existing.clientIds.length },
              after,
            },
    });
    return 'stored';
  });
}
