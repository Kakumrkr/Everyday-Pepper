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
  type MemoryFactShown,
  type MemorySettings,
  type MemorySubject,
  type ClientId,
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
  lockMemorySubjectKey,
  memoryPaused,
  memorySubjectOf,
  searchMemoryEpisodes,
  setMemoryPaused,
  MemorySubjectUnreachableError,
  findMemoryEpisode,
  findMemoryEpisodesByIds,
  findMemoryFact,
  latestVisitNotesOf,
  memoryFactsByIds,
  updateMemoryFact,
  withMember,
  type Database,
  type MemoryEpisodeSummaryRow,
  type MemoryFactRow,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { can } from '../permissions.js';
import { systemClock, type Clock } from '../clock.js';
import {
  MemoryEpisodeNotFoundError,
  MemoryFactNotFoundError,
  UndoRefusedError,
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
    await lockMemorySubjectKey(tx, fields.subject, fields.key);
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
    const value =
      fields.value !== undefined && fields.value !== current.value ? fields.value : null;
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
export async function forgetFactIn(
  tx: TenantTx,
  actor: Actor,
  factId: MemoryFactId,
): Promise<void> {
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

/** What activating a proposed save did to the subject's current fact. */
export type FactActivation = 'created' | 'updated' | 'unchanged';

/**
 * Makes a save the AI proposed (a `proposed` fact, S30) the subject's current fact, once the
 * member's dial allowed it or a person approved it: the subject's active fact with that key
 * takes the new value (the old one kept for the Undo window) and the proposed row goes, or the
 * proposed row itself becomes active. The proposed row going scrubs nothing (migration 0040).
 * `MemoryFactNotFoundError` for one that is not a proposed fact the member may change.
 */
export async function activateFactIn(
  tx: TenantTx,
  actor: Actor,
  proposedId: MemoryFactId,
  options: { clock?: Clock } = {},
): Promise<{ fact: MemoryFact; change: FactActivation; before: MemoryFact | null }> {
  const pending = await lockReachableFact(tx, actor, MemoryFactIdSchema.parse(proposedId));
  if (pending.status !== 'proposed') throw new MemoryFactNotFoundError();
  const subject = memorySubjectOf(pending);
  await lockMemorySubjectKey(tx, subject, pending.key);
  const current = await lockActiveMemoryFact(tx, subject, pending.key);
  if (current === undefined) {
    const activated = await updateMemoryFact(tx, MemoryFactIdSchema.parse(pending.id), {
      status: 'active',
    });
    if (activated === undefined) throw new MemoryFactNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'memory_fact.updated',
        entity: { type: 'memory_fact', id: activated.id },
        before: auditValues(pending),
        after: auditValues(activated),
      },
      requestId: actor.requestId,
    });
    return { fact: toMemoryFact(activated), change: 'created', before: null };
  }
  if (!(await deleteMemoryFact(tx, MemoryFactIdSchema.parse(pending.id)))) {
    throw new MemoryFactNotFoundError();
  }
  if (current.value === pending.value && current.sensitive === pending.sensitive) {
    return { fact: toMemoryFact(current), change: 'unchanged', before: toMemoryFact(current) };
  }
  const now = (options.clock ?? systemClock).now();
  const changed = await updateMemoryFact(tx, MemoryFactIdSchema.parse(current.id), {
    value: pending.value,
    sensitive: pending.sensitive,
    ...(current.value !== pending.value && {
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
  return { fact: toMemoryFact(changed), change: 'updated', before: toMemoryFact(current) };
}

/**
 * Undo of an AI save that replaced a value (S30): brings the replaced value back while its
 * Undo window is open, if the fact is still as the save left it (`updatedAt`). Otherwise
 * `UndoRefusedError('changed_since')`.
 */
export async function restoreFactIn(
  tx: TenantTx,
  actor: Actor,
  factId: MemoryFactId,
  savedAt: Date,
  options: { clock?: Clock } = {},
): Promise<void> {
  const id = MemoryFactIdSchema.parse(factId);
  const current = await lockReachableFact(tx, actor, id).catch((error: unknown) => {
    if (error instanceof MemoryFactNotFoundError) throw new UndoRefusedError('changed_since');
    throw error;
  });
  const now = (options.clock ?? systemClock).now();
  if (
    current.updatedAt.getTime() !== savedAt.getTime() ||
    current.previousValue === null ||
    current.previousUntil === null ||
    current.previousUntil.getTime() <= now.getTime()
  ) {
    throw new UndoRefusedError('changed_since');
  }
  const restored = await updateMemoryFact(tx, id, {
    value: current.previousValue,
    previousValue: null,
    previousUntil: null,
  });
  if (restored === undefined) throw new UndoRefusedError('changed_since');
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'memory_fact.updated',
      entity: { type: 'memory_fact', id },
      before: auditValues(current),
      after: auditValues(restored),
    },
    requestId: actor.requestId,
  });
}

/**
 * Undo of an AI save that created a fact (S30): forgets it everywhere, as any delete does
 * (ADR-0034), if it is still as the save left it (`updatedAt`); otherwise
 * `UndoRefusedError('changed_since')`.
 */
export async function forgetSavedFactIn(
  tx: TenantTx,
  actor: Actor,
  factId: MemoryFactId,
  savedAt: Date,
): Promise<void> {
  const id = MemoryFactIdSchema.parse(factId);
  const current = await lockReachableFact(tx, actor, id).catch((error: unknown) => {
    if (error instanceof MemoryFactNotFoundError) throw new UndoRefusedError('changed_since');
    throw error;
  });
  if (current.updatedAt.getTime() !== savedAt.getTime()) {
    throw new UndoRefusedError('changed_since');
  }
  await forgetFactIn(tx, actor, id);
}

/**
 * One fact the member may read, any status (the AI's `forget_fact`, S30).
 * `MemoryFactNotFoundError` otherwise.
 */
export async function getFactIn(
  tx: TenantTx,
  actor: Actor,
  factId: MemoryFactId,
): Promise<MemoryFact> {
  const row = await findMemoryFact(tx, MemoryFactIdSchema.parse(factId));
  if (row === undefined) throw new MemoryFactNotFoundError();
  requirePermission(actor, readPermission(memorySubjectOf(row)));
  return toMemoryFact(row);
}

/**
 * Removes a save the AI proposed that will not happen (the call was refused, or a retry found
 * the first one's proposal). Never remembered, so nothing is scrubbed. A fact that is not a
 * proposed one the member may change is left alone.
 */
export async function discardProposedFactIn(
  tx: TenantTx,
  actor: Actor,
  proposedId: MemoryFactId,
): Promise<void> {
  const id = MemoryFactIdSchema.parse(proposedId);
  const seen = await findMemoryFact(tx, id);
  if (seen?.status !== 'proposed') return;
  requirePermission(actor, managePermission(memorySubjectOf(seen)));
  await deleteMemoryFact(tx, id);
}

/**
 * Facts as a card, a receipt or *Why?* shows them, read live by id (S30): `gone` for one that
 * was deleted or that the member may not read; the replaced value only while Undo is open.
 */
export async function factsShownIn(
  tx: TenantTx,
  ids: readonly MemoryFactId[],
  now: Date,
): Promise<MemoryFactShown[]> {
  const rows = new Map((await memoryFactsByIds(tx, ids)).map((row) => [row.id, row]));
  return ids.map((id): MemoryFactShown => {
    const row = rows.get(id);
    if (row === undefined) return { state: 'gone', factId: id };
    const undoOpen = row.previousUntil !== null && row.previousUntil.getTime() > now.getTime();
    return {
      state: 'known',
      factId: id,
      subjectType: memorySubjectOf(row).type,
      key: row.key,
      value: row.value,
      previous: undoOpen ? row.previousValue : null,
      sensitive: row.sensitive,
    };
  });
}

/** A visit's notes, for "same as last time" (S30). */
export interface LastVisit {
  bookingId: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: Date;
  notes: MemoryFact[];
}

/** What travels with the records a tool answer returns (S30, playbook principle 2). */
export interface Recall {
  /** Active facts by subject (`client:<id>`, `booking:<id>`, ...), sensitive first. */
  facts: Map<string, MemoryFact[]>;
  /** Each client's latest visit that has notes. */
  lastVisits: Map<ClientId, LastVisit>;
}

/** The key `Recall.facts` files a subject under. */
export function subjectKey(subject: MemorySubject): string {
  return subject.type === 'business' ? 'business' : `${subject.type}:${subject.id}`;
}

/**
 * Recall for a tool answer (S30): the active facts of these subjects and the notes of these
 * clients' latest visits, only what the member may read (subjects they may not read are
 * skipped, never refused: recall must not break a lookup). At most `limit` facts.
 */
export async function recallIn(
  tx: TenantTx,
  actor: Actor,
  request: { subjects: readonly MemorySubject[]; lastVisitsOf: readonly ClientId[] },
  now: Date,
  limit = 40,
): Promise<Recall> {
  const readable = request.subjects.filter((subject) =>
    can(actor.context, readPermission(subject)),
  );
  const facts = new Map<string, MemoryFact[]>();
  for (const row of await activeMemoryFactsOf(tx, readable, limit)) {
    const fact = toMemoryFact(row);
    const key = subjectKey(fact.subject);
    facts.set(key, [...(facts.get(key) ?? []), fact]);
  }
  const lastVisits = new Map<ClientId, LastVisit>();
  if (can(actor.context, 'client_notes.read') && request.lastVisitsOf.length > 0) {
    for (const note of await latestVisitNotesOf(tx, request.lastVisitsOf, now, limit)) {
      const visit = lastVisits.get(note.clientId) ?? {
        bookingId: note.bookingId,
        serviceId: note.serviceId,
        staffMemberId: note.staffMemberId,
        startsAt: note.startsAt,
        notes: [],
      };
      visit.notes.push(toMemoryFact(note.fact));
      lastVisits.set(note.clientId, visit);
    }
  }
  return { facts, lastVisits };
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
  options: { clock?: Clock } = {},
): Promise<MemoryEpisode> {
  const fields = MemoryEpisodeInputSchema.parse(input);
  const userId = UserIdSchema.parse(member.userId);
  return withMember(db, member, async (tx) => {
    if (await memoryPaused(tx)) throw new MemoryPausedError();
    if ((await countMemoryEpisodesOf(tx, userId)) >= MEMORY_LIMITS.episodesPerMember) {
      throw new MemoryLimitError('episodes');
    }
    const row = await insertMemoryEpisode(tx, {
      ...fields,
      userId,
      ...(options.clock !== undefined && { createdAt: options.clock.now() }),
    });
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

/**
 * The member's own episodes with these ids, for the AI's answers that refer to them (S31):
 * gone or not theirs, an episode is simply absent.
 */
export async function episodesShownIn(
  tx: TenantTx,
  actor: Actor,
  ids: readonly MemoryEpisodeId[],
): Promise<MemoryEpisode[]> {
  requirePermission(actor, 'ai.chat');
  return (await findMemoryEpisodesByIds(tx, ids)).map(toEpisode);
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
