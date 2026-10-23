import {
  ConversationIdSchema,
  ConversationTurnIdSchema,
  EmbeddingModelSchema,
  EmbeddingSchema,
  MEMORY_LIMITS,
  MemoryEpisodeIdSchema,
  MemoryFactIdSchema,
  MemoryFactKeySchema,
  MemoryFactStatusSchema,
  MemorySourceSchema,
  MemorySubjectSchema,
  MemorySubjectTypeSchema,
  ClientIdSchema,
  type ClientId,
  type ConversationId,
  type ConversationTurnId,
  type Embedding,
  type MemoryEpisodeId,
  type MemoryFactId,
  type MemoryFactStatus,
  type MemorySource,
  type MemorySubject,
  type MemorySubjectType,
  type UserId,
} from '@pepper/contracts';
import { and, asc, count, desc, eq, inArray, isNotNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  memoryEpisodes,
  memoryFacts,
  tenants,
  type MemoryEpisodeRow,
  type MemoryFactRow,
} from '../schema.js';
import {
  isForeignKeyViolation,
  isPolicyViolation,
  MemorySubjectUnreachableError,
} from '../errors.js';
import type { TenantTx } from '../tenant.js';

// What Pepper remembers, for the transaction's tenant (ADR-0034). Run inside `withMember` for a
// member's request: the member-scope policies then limit staff to the facts of the clients and
// visits they reach, their own staff member, and the business's non-sensitive facts, and every
// member to their own episodes. Deleting a fact (here, or with its subject) scrubs its value
// from the business's stored conversations and episodes in the same transaction (migration
// 0039). Values never leave these tables except to the member who reads them.

const Id = z.uuid();
const LimitSchema = z.number().int().min(1).max(10_000);
const ValueSchema = z.string().min(1).max(MEMORY_LIMITS.valueMax);

/** The subject's columns: its type and the one key of that type (none for the business). */
function subjectColumns(subject: MemorySubject): {
  subjectType: MemorySubjectType;
  clientId: string | null;
  staffMemberId: string | null;
  serviceId: string | null;
  bookingId: string | null;
} {
  const parsed = MemorySubjectSchema.parse(subject);
  return {
    subjectType: parsed.type,
    clientId: parsed.type === 'client' ? parsed.id : null,
    staffMemberId: parsed.type === 'staff' ? parsed.id : null,
    serviceId: parsed.type === 'service' ? parsed.id : null,
    bookingId: parsed.type === 'booking' ? parsed.id : null,
  };
}

/** The condition matching one subject's facts. */
function subjectIs(subject: MemorySubject): SQL {
  const columns = subjectColumns(subject);
  switch (columns.subjectType) {
    case 'business':
      return eq(memoryFacts.subjectType, 'business');
    case 'client':
      return sql`(${eq(memoryFacts.subjectType, 'client')} AND ${eq(memoryFacts.clientId, Id.parse(columns.clientId))})`;
    case 'staff':
      return sql`(${eq(memoryFacts.subjectType, 'staff')} AND ${eq(memoryFacts.staffMemberId, Id.parse(columns.staffMemberId))})`;
    case 'service':
      return sql`(${eq(memoryFacts.subjectType, 'service')} AND ${eq(memoryFacts.serviceId, Id.parse(columns.serviceId))})`;
    case 'booking':
      return sql`(${eq(memoryFacts.subjectType, 'booking')} AND ${eq(memoryFacts.bookingId, Id.parse(columns.bookingId))})`;
  }
}

/** A stored fact's subject. */
export function memorySubjectOf(row: MemoryFactRow): MemorySubject {
  const type = MemorySubjectTypeSchema.parse(row.subjectType);
  if (type === 'business') return { type };
  const id = {
    client: row.clientId,
    staff: row.staffMemberId,
    service: row.serviceId,
    booking: row.bookingId,
  }[type];
  return MemorySubjectSchema.parse({ type, id });
}

export interface NewMemoryFact {
  subject: MemorySubject;
  key: string;
  value: string;
  sensitive: boolean;
  status: MemoryFactStatus;
  source: MemorySource;
  sourceTurnId: ConversationTurnId | null;
  createdBy: UserId | null;
}

/**
 * Throws `MemorySubjectUnreachableError` when the subject is not one the transaction may reach
 * (the insert runs in a savepoint, so the caller's transaction stays usable).
 */
export async function insertMemoryFact(tx: TenantTx, input: NewMemoryFact): Promise<MemoryFactRow> {
  try {
    return await tx.transaction((savepoint) => insertFact(savepoint, input));
  } catch (error) {
    if (isPolicyViolation(error) || SUBJECT_KEYS.some((key) => isForeignKeyViolation(error, key))) {
      throw new MemorySubjectUnreachableError();
    }
    throw error;
  }
}

const SUBJECT_KEYS = [
  'memory_facts_client_fk',
  'memory_facts_staff_member_fk',
  'memory_facts_service_fk',
  'memory_facts_booking_fk',
];

async function insertFact(tx: TenantTx, input: NewMemoryFact): Promise<MemoryFactRow> {
  const [row] = await tx
    .insert(memoryFacts)
    .values({
      ...subjectColumns(input.subject),
      key: MemoryFactKeySchema.parse(input.key),
      value: ValueSchema.parse(input.value),
      sensitive: input.sensitive,
      status: MemoryFactStatusSchema.parse(input.status),
      source: MemorySourceSchema.parse(input.source),
      sourceTurnId:
        input.sourceTurnId === null ? null : ConversationTurnIdSchema.parse(input.sourceTurnId),
      createdByUserId: input.createdBy === null ? null : Id.parse(input.createdBy),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** The fact with this id the transaction may read. */
export async function findMemoryFact(
  tx: TenantTx,
  id: MemoryFactId,
): Promise<MemoryFactRow | undefined> {
  const [row] = await tx
    .select()
    .from(memoryFacts)
    .where(eq(memoryFacts.id, MemoryFactIdSchema.parse(id)));
  return row;
}

/**
 * The fact with this id the transaction may change, locked until it ends (`FOR UPDATE`): a
 * staff member may read the business's facts but not lock them.
 */
export async function lockMemoryFact(
  tx: TenantTx,
  id: MemoryFactId,
): Promise<MemoryFactRow | undefined> {
  const [row] = await tx
    .select()
    .from(memoryFacts)
    .where(eq(memoryFacts.id, MemoryFactIdSchema.parse(id)))
    .for('update');
  return row;
}

/** The subject's active fact with this key, locked (`FOR UPDATE`): the one a save replaces. */
export async function lockActiveMemoryFact(
  tx: TenantTx,
  subject: MemorySubject,
  key: string,
): Promise<MemoryFactRow | undefined> {
  const [row] = await tx
    .select()
    .from(memoryFacts)
    .where(
      and(
        subjectIs(subject),
        eq(memoryFacts.key, MemoryFactKeySchema.parse(key)),
        eq(memoryFacts.status, 'active'),
      ),
    )
    .for('update');
  return row;
}

/** A change to a fact; `undefined` fields stay as they are. */
export interface MemoryFactUpdate {
  value?: string;
  previousValue?: string | null;
  previousUntil?: Date | null;
  sensitive?: boolean;
  status?: MemoryFactStatus;
}

export async function updateMemoryFact(
  tx: TenantTx,
  id: MemoryFactId,
  change: MemoryFactUpdate,
): Promise<MemoryFactRow | undefined> {
  const [row] = await tx
    .update(memoryFacts)
    .set({
      ...(change.value !== undefined && { value: ValueSchema.parse(change.value) }),
      ...(change.previousValue !== undefined && {
        previousValue:
          change.previousValue === null ? null : ValueSchema.parse(change.previousValue),
      }),
      ...(change.previousUntil !== undefined && { previousUntil: change.previousUntil }),
      ...(change.sensitive !== undefined && { sensitive: change.sensitive }),
      ...(change.status !== undefined && { status: MemoryFactStatusSchema.parse(change.status) }),
    })
    .where(eq(memoryFacts.id, MemoryFactIdSchema.parse(id)))
    .returning();
  return row;
}

/**
 * Deletes a fact the transaction may delete, and with it (trigger) its value from the
 * business's stored conversations and episodes. Returns whether it was there.
 */
export async function deleteMemoryFact(tx: TenantTx, id: MemoryFactId): Promise<boolean> {
  const deleted = await tx
    .delete(memoryFacts)
    .where(eq(memoryFacts.id, MemoryFactIdSchema.parse(id)))
    .returning({ id: memoryFacts.id });
  return deleted.length > 0;
}

export interface MemoryFactFilter {
  subjectType?: MemorySubjectType | undefined;
  subject?: MemorySubject | undefined;
  status: MemoryFactStatus;
  sensitive?: boolean | undefined;
  limit: number;
}

/** Facts the transaction may read, by subject type then newest first. */
export async function listMemoryFacts(
  tx: TenantTx,
  filter: MemoryFactFilter,
): Promise<MemoryFactRow[]> {
  const conditions: SQL[] = [eq(memoryFacts.status, MemoryFactStatusSchema.parse(filter.status))];
  if (filter.subjectType !== undefined) {
    conditions.push(eq(memoryFacts.subjectType, MemorySubjectTypeSchema.parse(filter.subjectType)));
  }
  if (filter.subject !== undefined) conditions.push(subjectIs(filter.subject));
  if (filter.sensitive !== undefined) conditions.push(eq(memoryFacts.sensitive, filter.sensitive));
  return tx
    .select()
    .from(memoryFacts)
    .where(and(...conditions))
    .orderBy(asc(memoryFacts.subjectType), desc(memoryFacts.updatedAt), asc(memoryFacts.id))
    .limit(LimitSchema.parse(filter.limit));
}

/**
 * The active facts of these subjects the transaction may read (recall, ADR-0034): what a tool
 * answer about a client, staff member, service or visit carries, and the business's own.
 */
export async function activeMemoryFactsOf(
  tx: TenantTx,
  subjects: readonly MemorySubject[],
  limit: number,
): Promise<MemoryFactRow[]> {
  if (subjects.length === 0) return [];
  return tx
    .select()
    .from(memoryFacts)
    .where(and(eq(memoryFacts.status, 'active'), or(...subjects.map(subjectIs))))
    .orderBy(desc(memoryFacts.sensitive), desc(memoryFacts.updatedAt), asc(memoryFacts.id))
    .limit(LimitSchema.parse(limit));
}

/** How many facts (any status) a subject has, and the business in all. */
export async function countMemoryFacts(
  tx: TenantTx,
  subject: MemorySubject,
): Promise<{ subject: number; business: number }> {
  const [row] = await tx
    .select({
      subject: sql<number>`count(*) FILTER (WHERE ${subjectIs(subject)})::int`,
      business: sql<number>`count(*)::int`,
    })
    .from(memoryFacts);
  return { subject: row?.subject ?? 0, business: row?.business ?? 0 };
}

/**
 * Clears up to `limit` replaced values whose Undo window ended before `now` (the daily
 * clean-up). Returns how many it cleared.
 */
export async function clearExpiredMemoryPreviousValues(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<number> {
  const batch = tx
    .select({ id: memoryFacts.id })
    .from(memoryFacts)
    .where(and(isNotNull(memoryFacts.previousUntil), lt(memoryFacts.previousUntil, now)))
    .limit(LimitSchema.parse(limit));
  const cleared = await tx
    .update(memoryFacts)
    .set({ previousValue: null, previousUntil: null })
    .where(inArray(memoryFacts.id, batch))
    .returning({ id: memoryFacts.id });
  return cleared.length;
}

export interface NewMemoryEpisode {
  userId: UserId;
  conversationId: ConversationId | null;
  summary: string;
  clientIds: readonly ClientId[];
  embedding: Embedding;
  embeddingModel: string;
}

export async function insertMemoryEpisode(
  tx: TenantTx,
  input: NewMemoryEpisode,
): Promise<MemoryEpisodeRow> {
  const [row] = await tx
    .insert(memoryEpisodes)
    .values({
      userId: Id.parse(input.userId),
      conversationId:
        input.conversationId === null ? null : ConversationIdSchema.parse(input.conversationId),
      summary: z.string().min(1).max(MEMORY_LIMITS.episodeSummaryMax).parse(input.summary),
      clientIds: z
        .array(ClientIdSchema)
        .max(MEMORY_LIMITS.episodeClientsMax)
        .parse([...new Set(input.clientIds)]),
      embedding: EmbeddingSchema.parse(input.embedding),
      embeddingModel: EmbeddingModelSchema.parse(input.embeddingModel),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** An episode without its embedding (never needed outside the database). */
export type MemoryEpisodeSummaryRow = Omit<MemoryEpisodeRow, 'embedding'>;

const episodeColumns = {
  id: memoryEpisodes.id,
  tenantId: memoryEpisodes.tenantId,
  userId: memoryEpisodes.userId,
  conversationId: memoryEpisodes.conversationId,
  summary: memoryEpisodes.summary,
  clientIds: memoryEpisodes.clientIds,
  embeddingModel: memoryEpisodes.embeddingModel,
  createdAt: memoryEpisodes.createdAt,
};

/** The episodes the transaction may read (a member: their own), newest first. */
export async function listMemoryEpisodes(
  tx: TenantTx,
  limit: number,
): Promise<MemoryEpisodeSummaryRow[]> {
  return tx
    .select(episodeColumns)
    .from(memoryEpisodes)
    .orderBy(desc(memoryEpisodes.createdAt), desc(memoryEpisodes.id))
    .limit(LimitSchema.parse(limit));
}

/**
 * The `limit` episodes the transaction may read that are most similar to `embedding` (cosine),
 * most similar first. Exact search, no index (playbook D-4): the member scope filters before
 * the limit, so every match the member may see is considered.
 */
export async function searchMemoryEpisodes(
  tx: TenantTx,
  embedding: Embedding,
  limit: number,
): Promise<(MemoryEpisodeSummaryRow & { similarity: number })[]> {
  const vector = JSON.stringify(EmbeddingSchema.parse(embedding));
  const max = z.number().int().min(1).max(MEMORY_LIMITS.searchResultsMax).parse(limit);
  const distance = sql<string>`(${memoryEpisodes.embedding} <=> ${vector}::vector)`;
  const rows = await tx
    .select({ ...episodeColumns, distance })
    .from(memoryEpisodes)
    .orderBy(distance, asc(memoryEpisodes.id))
    .limit(max);
  return rows.map(({ distance: d, ...row }) => ({ ...row, similarity: 1 - Number(d) }));
}

/** The episode with this id the transaction may read (a member: their own). */
export async function findMemoryEpisode(
  tx: TenantTx,
  id: MemoryEpisodeId,
): Promise<MemoryEpisodeSummaryRow | undefined> {
  const [row] = await tx
    .select(episodeColumns)
    .from(memoryEpisodes)
    .where(eq(memoryEpisodes.id, MemoryEpisodeIdSchema.parse(id)));
  return row;
}

/** Deletes an episode the transaction may delete (a member: their own). Returns whether it was there. */
export async function deleteMemoryEpisode(tx: TenantTx, id: MemoryEpisodeId): Promise<boolean> {
  const deleted = await tx
    .delete(memoryEpisodes)
    .where(eq(memoryEpisodes.id, MemoryEpisodeIdSchema.parse(id)))
    .returning({ id: memoryEpisodes.id });
  return deleted.length > 0;
}

/** How many episodes a member has. */
export async function countMemoryEpisodesOf(tx: TenantTx, userId: UserId): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(memoryEpisodes)
    .where(eq(memoryEpisodes.userId, Id.parse(userId)));
  return row?.n ?? 0;
}

/** Deletes up to `limit` episodes written before `before` (the clean-up's retention). */
export async function deleteOldMemoryEpisodes(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const batch = tx
    .select({ id: memoryEpisodes.id })
    .from(memoryEpisodes)
    .where(lt(memoryEpisodes.createdAt, before))
    .limit(LimitSchema.parse(limit));
  const deleted = await tx
    .delete(memoryEpisodes)
    .where(inArray(memoryEpisodes.id, batch))
    .returning({ id: memoryEpisodes.id });
  return deleted.length;
}

/** Whether the transaction's business has paused remembering new things. */
export async function memoryPaused(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.select({ paused: tenants.memoryPaused }).from(tenants);
  return row?.paused ?? false;
}

/** Pauses or resumes remembering for the transaction's business. Returns the previous value. */
export async function setMemoryPaused(tx: TenantTx, paused: boolean): Promise<boolean> {
  const [before] = await tx.select({ paused: tenants.memoryPaused }).from(tenants).for('update');
  await tx.update(tenants).set({ memoryPaused: paused });
  return before?.paused ?? false;
}
