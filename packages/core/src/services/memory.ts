import {
  ConversationTurnIdSchema,
  MEMORY_LIMITS,
  MemoryEpisodeIdSchema,
  MemoryEpisodeInputSchema,
  MemoryFactChangeSchema,
  MemoryFactIdSchema,
  MemoryFactInputSchema,
  MemoryFactOriginSchema,
  MemoryFactQuerySchema,
  MemoryFactSchema,
  MemorySettingsSchema,
  MemorySourceSchema,
  MemoryEpisodeSchema,
  MemoryEpisodeMatchSchema,
  MemoryFactStatusSchema,
  SENSITIVE_MEMORY_KEYS,
  UserIdSchema,
  type Embedding,
  type MemoryEpisode,
  type MemoryEpisodeId,
  type MemoryEpisodeInput,
  type MemoryEpisodeMatch,
  type MemoryFact,
  type MemoryFactChange,
  type MemoryFactId,
  type MemoryFactInput,
  type MemoryFactOrigin,
  type MemoryFactQuery,
  type MemorySettings,
  type MemorySubject,
  type Permission,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  activeMemoryFactsOf,
  appendAuditEntry,
  countMemoryEpisodesOf,
  countMemoryFacts,
  deleteMemoryEpisode,
  deleteMemoryFact,
  insertMemoryEpisode,
  insertMemoryFact,
  listMemoryEpisodes,
  listMemoryFacts,
  lockActiveMemoryFact,
  lockMemoryFact,
  memoryPaused,
  memorySubjectOf,
  searchMemoryEpisodes,
  setMemoryPaused,
  MemorySubjectUnreachableError,
  findMemoryEpisode,
  findMemoryFact,
  updateMemoryFact,
  withMember,
  type Database,
  type MemoryEpisodeSummaryRow,
  type MemoryFactRow,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import {
  MemoryEpisodeNotFoundError,
  MemoryFactNotFoundError,
  MemoryLimitError,
  MemoryPausedError,
  MemorySubjectNotFoundError,
} from '../errors.js';

// What Pepper remembers (Phase 7, ADR-0034). Facts about a client or one visit follow the
// client notes permissions (staff: their own clients, which the database's member scope
// applies too); facts about the business, a staff member or a service are changed by those
// who manage them and read by everyone, except sensitive ones. A fact's value is free text a
// member typed, so audit entries record only its subject type, key and flags. Deleting a fact
// removes its value everywhere (migration 0039): the business's stored chats and episodes.
// Episodes are each member's own, written by the episode job (S31).

const DAY_MS = 86_400_000;

/** The permission that changes a subject's facts. */
function managePermission(subject: MemorySubject): Permission {
  switch (subject.type) {
    case 'client':
    case 'booking':
      return 'client_notes.manage';
    case 'staff':
      return 'staff.manage';
    case 'service':
      return 'services.manage';
    case 'business':
      return 'business.update';
  }
}

/** The permission that reads a subject's facts. */
function readPermission(subject: MemorySubject): Permission {
  return subject.type === 'client' || subject.type === 'booking'
    ? 'client_notes.read'
    : 'business.read';
}

function auditValues(row: MemoryFactRow) {
  return {
    subjectType: memorySubjectOf(row).type,
    key: row.key,
    sensitive: row.sensitive,
    status: MemoryFactStatusSchema.parse(row.status),
    source: MemorySourceSchema.parse(row.source),
  };
}

export function toMemoryFact(row: MemoryFactRow): MemoryFact {
  return MemoryFactSchema.parse({
    id: row.id,
    subject: memorySubjectOf(row),
    key: row.key,
    value: row.value,
    sensitive: row.sensitive,
    status: row.status,
    source: row.source,
    sourceTurnId: row.sourceTurnId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** The outcome of a save: the fact, and the value it replaced (`null` for a new fact). */
export interface SavedFact {
  fact: MemoryFact;
  replaced: string | null;
}

/**
 * Saves a fact for the member. A subject's active fact with the same key gets the new value;
 * the old one is kept for the 7-day Undo window only. `MemoryPausedError` when the business
 * paused remembering and the fact did not come from a member on a screen;
 * `MemorySubjectNotFoundError` for a subject the member can't reach; `MemoryLimitError` past
 * the caps.
 */
export async function saveFact(
  db: Database,
  actor: Actor,
  input: MemoryFactInput,
  origin: MemoryFactOrigin = { source: 'screen' },
  options: { clock?: Clock } = {},
): Promise<SavedFact> {
  const fields = MemoryFactInputSchema.parse(input);
  requirePermission(actor, managePermission(fields.subject));
  return withMember(db, actor.context, (tx) => saveFactIn(tx, actor, fields, origin, options));
}

/** `saveFact` inside the caller's transaction (the AI's `remember_fact`, S30). */
export async function saveFactIn(
  tx: TenantTx,
  actor: Actor,
  input: MemoryFactInput,
  origin: MemoryFactOrigin = { source: 'screen' },
  options: { clock?: Clock } = {},
): Promise<SavedFact> {
  const fields = MemoryFactInputSchema.parse(input);
  const from = MemoryFactOriginSchema.parse(origin);
  requirePermission(actor, managePermission(fields.subject));
  if (from.source !== 'screen' && (await memoryPaused(tx))) throw new MemoryPausedError();
  const sensitive = fields.sensitive ?? SENSITIVE_MEMORY_KEYS.includes(fields.key);
  const now = (options.clock ?? systemClock).now();

  if (from.status === 'active') {
    const current = await lockActiveMemoryFact(tx, fields.subject, fields.key);
    if (current !== undefined) {
      if (current.value === fields.value && current.sensitive === sensitive) {
        return { fact: toMemoryFact(current), replaced: null };
      }
      const changed = await updateMemoryFact(tx, MemoryFactIdSchema.parse(current.id), {
        value: fields.value,
        sensitive,
        ...(current.value !== fields.value && {
          previousValue: current.value,
          previousUntil: new Date(now.getTime() + MEMORY_LIMITS.previousValueDays * DAY_MS),
        }),
      });
      // The row is locked and reachable; the update can't miss it.
      if (changed === undefined) throw new MemoryFactNotFoundError();
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'memory_fact.updated',
          entity: { type: 'memory_fact', id: changed.id },
          before: auditValues(current),
          after: auditValues(changed),
        },
        requestId: actor.requestId,
      });
      return {
        fact: toMemoryFact(changed),
        replaced: current.value === fields.value ? null : current.value,
      };
    }
  }

  const counts = await countMemoryFacts(tx, fields.subject);
  if (counts.subject >= MEMORY_LIMITS.factsPerSubject) throw new MemoryLimitError('subject');
  if (counts.business >= MEMORY_LIMITS.factsPerBusiness) throw new MemoryLimitError('business');
  const row = await subjectReachable(() =>
    insertMemoryFact(tx, {
      subject: fields.subject,
      key: fields.key,
      value: fields.value,
      sensitive,
      status: from.status,
      source: from.source,
      sourceTurnId: from.turnId === null ? null : ConversationTurnIdSchema.parse(from.turnId),
      createdBy: actor.context.userId,
    }),
  );
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'memory_fact.created',
      entity: { type: 'memory_fact', id: row.id },
      before: null,
      after: auditValues(row),
    },
    requestId: actor.requestId,
  });
  return { fact: toMemoryFact(row), replaced: null };
}

/**
 * The fact, locked, once the member may change it: `MemoryFactNotFoundError` for one they
 * can't read, `ForbiddenError` for one they read but may not change.
 */
async function lockReachableFact(
  tx: TenantTx,
  actor: Actor,
  id: MemoryFactId,
): Promise<MemoryFactRow> {
  const seen = await findMemoryFact(tx, id);
  if (seen === undefined) throw new MemoryFactNotFoundError();
  requirePermission(actor, managePermission(memorySubjectOf(seen)));
  const current = await lockMemoryFact(tx, id);
  if (current === undefined) throw new MemoryFactNotFoundError();
  return current;
}

/** A subject the member can't reach (or none at all) is "no such subject" to them. */
async function subjectReachable<T>(insert: () => Promise<T>): Promise<T> {
  try {
    return await insert();
  } catch (error) {
    if (error instanceof MemorySubjectUnreachableError) throw new MemorySubjectNotFoundError();
    throw error;
  }
}

/**
 * Changes a fact's value or sensitivity. A new value keeps the old one for the Undo window.
 * `MemoryFactNotFoundError` for one the member can't reach.
 */
export async function changeFact(
  db: Database,
  actor: Actor,
  factId: MemoryFactId,
  change: MemoryFactChange,
  options: { clock?: Clock } = {},
): Promise<MemoryFact> {
  const id = MemoryFactIdSchema.parse(factId);
  const fields = MemoryFactChangeSchema.parse(change);
  return withMember(db, actor.context, async (tx) => {
    const current = await lockReachableFact(tx, actor, id);
    const now = (options.clock ?? systemClock).now();
    const value = fields.value !== undefined && fields.value !== current.value ? fields.value : null;
    const changed = await updateMemoryFact(tx, id, {
      ...(fields.sensitive !== undefined && { sensitive: fields.sensitive }),
      ...(value !== null && {
        value,
        previousValue: current.value,
        previousUntil: new Date(now.getTime() + MEMORY_LIMITS.previousValueDays * DAY_MS),
      }),
    });
    // Readable but not changeable (a staff member and the business's facts): not theirs.
    if (changed === undefined) throw new MemoryFactNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'memory_fact.updated',
        entity: { type: 'memory_fact', id },
        before: auditValues(current),
        after: auditValues(changed),
      },
      requestId: actor.requestId,
    });
    return toMemoryFact(changed);
  });
}

/**
 * Forgets a fact: deletes it and, in the same transaction, removes its value (and a replaced
 * value still kept for Undo) from the business's stored conversations and episodes (playbook
 * principle 7). Final. `MemoryFactNotFoundError` for one the member can't reach.
 */
export async function forgetFact(db: Database, actor: Actor, factId: MemoryFactId): Promise<void> {
  const id = MemoryFactIdSchema.parse(factId);
  await withMember(db, actor.context, (tx) => forgetFactIn(tx, actor, id));
}

/** `forgetFact` inside the caller's transaction (the AI's `forget_fact` and Undo, S30). */
export async function forgetFactIn(tx: TenantTx, actor: Actor, factId: MemoryFactId): Promise<void> {
  const id = MemoryFactIdSchema.parse(factId);
  const current = await lockReachableFact(tx, actor, id);
  if (!(await deleteMemoryFact(tx, id))) throw new MemoryFactNotFoundError();
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'memory_fact.deleted',
      entity: { type: 'memory_fact', id },
      before: auditValues(current),
      after: null,
    },
    requestId: actor.requestId,
  });
}

/** The facts the member may read ("What I know", S32). */
export async function listFacts(
  db: Database,
  actor: Actor,
  query: MemoryFactQuery = {},
): Promise<MemoryFact[]> {
  const filter = MemoryFactQuerySchema.parse(query);
  requirePermission(
    actor,
    filter.subject === undefined ? 'business.read' : readPermission(filter.subject),
  );
  return withMember(db, actor.context, async (tx) =>
    (await listMemoryFacts(tx, filter)).map(toMemoryFact),
  );
}

/**
 * The active facts of these subjects the member may read, sensitive first, at most `limit`
 * (recall: what travels with a client, staff member, service or visit in a tool answer, S30).
 */
export async function factsForIn(
  tx: TenantTx,
  actor: Actor,
  subjects: readonly MemorySubject[],
  limit = 50,
): Promise<MemoryFact[]> {
  for (const subject of subjects) requirePermission(actor, readPermission(subject));
  return (await activeMemoryFactsOf(tx, subjects, limit)).map(toMemoryFact);
}

/** The business's memory settings. */
export async function getMemorySettings(db: Database, actor: Actor): Promise<MemorySettings> {
  requirePermission(actor, 'business.read');
  return withMember(db, actor.context, async (tx) => ({ paused: await memoryPaused(tx) }));
}

/** Pauses or resumes remembering new things (owners and managers). */
export async function changeMemorySettings(
  db: Database,
  actor: Actor,
  settings: MemorySettings,
): Promise<MemorySettings> {
  requirePermission(actor, 'settings.manage');
  const { paused } = MemorySettingsSchema.parse(settings);
  return withMember(db, actor.context, async (tx) => {
    const before = await setMemoryPaused(tx, paused);
    if (before !== paused) {
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'memory.settings_updated',
          entity: { type: 'tenant', id: actor.context.tenantId },
          before: { paused: before },
          after: { paused },
        },
        requestId: actor.requestId,
      });
    }
    return { paused };
  });
}

function toEpisode(row: MemoryEpisodeSummaryRow): MemoryEpisode {
  return MemoryEpisodeSchema.parse({
    id: row.id,
    conversationId: row.conversationId,
    summary: row.summary,
    clientIds: row.clientIds,
    createdAt: row.createdAt.toISOString(),
  });
}

/**
 * Stores an episode of `member`'s conversation (the episode job, S31, as the platform).
 * `MemoryPausedError` when the business paused remembering; `MemoryLimitError` when the member
 * has the most episodes kept.
 */
export async function saveEpisode(
  db: Database,
  member: { tenantId: TenantId; userId: UserId },
  input: MemoryEpisodeInput,
): Promise<MemoryEpisode> {
  const fields = MemoryEpisodeInputSchema.parse(input);
  const userId = UserIdSchema.parse(member.userId);
  return withMember(db, member, async (tx) => {
    if (await memoryPaused(tx)) throw new MemoryPausedError();
    if ((await countMemoryEpisodesOf(tx, userId)) >= MEMORY_LIMITS.episodesPerMember) {
      throw new MemoryLimitError('episodes');
    }
    const row = await insertMemoryEpisode(tx, { ...fields, userId });
    await appendAuditEntry(tx, {
      actor: { kind: 'system' },
      change: {
        action: 'memory_episode.created',
        entity: { type: 'memory_episode', id: row.id },
        before: null,
        after: { clientCount: row.clientIds.length },
      },
    });
    return toEpisode(row);
  });
}

/** The member's own episodes, newest first. */
export async function listMyEpisodes(
  db: Database,
  actor: Actor,
  limit = 100,
): Promise<MemoryEpisode[]> {
  requirePermission(actor, 'ai.chat');
  return withMember(db, actor.context, async (tx) =>
    (await listMemoryEpisodes(tx, limit)).map(toEpisode),
  );
}

/**
 * The member's own episodes most similar to `embedding`, most similar first (the AI's
 * `search_memory`, S31).
 */
export async function searchEpisodesIn(
  tx: TenantTx,
  actor: Actor,
  embedding: Embedding,
  limit = 5,
): Promise<MemoryEpisodeMatch[]> {
  requirePermission(actor, 'ai.chat');
  const rows = await searchMemoryEpisodes(tx, embedding, limit);
  return rows.map(({ similarity, ...row }) =>
    MemoryEpisodeMatchSchema.parse({ ...toEpisode(row), similarity }),
  );
}

/** Deletes one of the member's own episodes. `MemoryEpisodeNotFoundError` otherwise. */
export async function deleteEpisode(
  db: Database,
  actor: Actor,
  episodeId: MemoryEpisodeId,
): Promise<void> {
  requirePermission(actor, 'ai.chat');
  const id = MemoryEpisodeIdSchema.parse(episodeId);
  await withMember(db, actor.context, async (tx) => {
    const row = await findMemoryEpisode(tx, id);
    if (row === undefined || !(await deleteMemoryEpisode(tx, id))) {
      throw new MemoryEpisodeNotFoundError();
    }
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'memory_episode.deleted',
        entity: { type: 'memory_episode', id },
        before: { clientCount: row.clientIds.length },
        after: null,
      },
      requestId: actor.requestId,
    });
  });
}
