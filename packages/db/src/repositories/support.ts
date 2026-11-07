import {
  PublicSupportStatusSchema,
  SupportKindSchema,
  SupportReferenceSchema,
  SupportStatusSchema,
  UserIdSchema,
  type PublicSupportStatus,
  type SupportKind,
  type SupportStatus,
  type UserId,
} from '@pepper/contracts';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  memberships,
  publicSupportRequests,
  supportMessages,
  supportNotes,
  supportReads,
  supportThreads,
  users,
} from '../schema.js';
import { isUniqueViolation } from '../errors.js';
import { newId } from '../ids.js';
import type { TenantTx } from '../tenant.js';

// Support threads (S59, PCR-010, AC-X-14…18). Rows only: who may do what is the core
// service's; who may read which thread is the tables' RLS (the opener, and the business's owners
// and managers). Message bodies are the writers' own text: returned to readers, never logged.

const Id = z.uuid();

/** A thread as stored, with what "Your requests" shows of it. */
export interface SupportThreadRecord {
  id: string;
  reference: string;
  kind: SupportKind;
  status: SupportStatus;
  openedByUserId: string | null;
  /** The opener's display name; `null` once their account is deleted. */
  openedByName: string | null;
  /** The first message, cut to 140 characters. */
  preview: string;
  /** The team answered after the reader last opened it (the reader's own threads only). */
  unread: boolean;
  context: unknown;
  createdAt: Date;
  lastMessageAt: Date;
}

export interface SupportMessageRecord {
  id: string;
  authorKind: 'member' | 'pepper';
  authorUserId: string | null;
  /** The writer's display name; `null` for the team or a deleted account. */
  authorName: string | null;
  body: string;
  createdAt: Date;
}

const PREVIEW_LENGTH = 140;

/**
 * Opens a thread with its first message. `null` when `reference` is taken (by any business):
 * the caller draws another. Written with the transaction's tenant.
 */
export async function insertSupportThread(
  tx: TenantTx,
  input: {
    reference: string;
    kind: SupportKind;
    openedByUserId: UserId;
    context: Record<string, unknown>;
    body: string;
    now: Date;
  },
): Promise<{ id: string } | null> {
  const openedByUserId = UserIdSchema.parse(input.openedByUserId);
  const [thread] = await tx
    .insert(supportThreads)
    .values({
      reference: SupportReferenceSchema.parse(input.reference),
      kind: SupportKindSchema.parse(input.kind),
      status: 'waiting_on_pepper',
      openedByUserId,
      context: input.context,
      lastMessageAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: supportThreads.reference })
    .returning({ id: supportThreads.id });
  if (thread === undefined) return null;
  await tx.insert(supportMessages).values({
    threadId: thread.id,
    authorKind: 'member',
    authorUserId: openedByUserId,
    body: input.body,
    createdAt: input.now,
  });
  return thread;
}

/** The columns "Your requests" shows; `reader` decides `unread`. */
function threadColumns(reader: UserId | null) {
  const readerId = reader === null ? sql`NULL::uuid` : sql`${UserIdSchema.parse(reader)}::uuid`;
  return {
    id: supportThreads.id,
    reference: supportThreads.reference,
    kind: supportThreads.kind,
    status: supportThreads.status,
    openedByUserId: supportThreads.openedByUserId,
    openedByName: users.name,
    context: supportThreads.context,
    createdAt: supportThreads.createdAt,
    lastMessageAt: supportThreads.lastMessageAt,
    preview: sql<string>`(SELECT left(m.body, ${sql.raw(String(PREVIEW_LENGTH))}) FROM support_messages m WHERE m.thread_id = ${supportThreads.id} ORDER BY m.created_at, m.id LIMIT 1)`,
    unread: sql<boolean>`(${supportThreads.openedByUserId} = ${readerId} AND EXISTS (SELECT 1 FROM support_messages m WHERE m.thread_id = ${supportThreads.id} AND m.author_kind = 'pepper' AND m.created_at > COALESCE((SELECT r.read_at FROM support_reads r WHERE r.thread_id = ${supportThreads.id} AND r.user_id = ${readerId}), '-infinity'::timestamptz)))`,
  };
}

function toThreadRecord(row: {
  id: string;
  reference: string;
  kind: string;
  status: string;
  openedByUserId: string | null;
  openedByName: string | null;
  context: unknown;
  createdAt: Date;
  lastMessageAt: Date;
  preview: string | null;
  unread: boolean | null;
}): SupportThreadRecord {
  return {
    ...row,
    kind: SupportKindSchema.parse(row.kind),
    status: SupportStatusSchema.parse(row.status),
    preview: row.preview ?? '',
    unread: row.unread === true,
  };
}

/** The threads the transaction's member may read, newest activity first. */
export async function listSupportThreads(
  tx: TenantTx,
  query: { reader: UserId; limit: number },
): Promise<SupportThreadRecord[]> {
  const limit = z.number().int().min(1).max(200).parse(query.limit);
  const rows = await tx
    .select(threadColumns(query.reader))
    .from(supportThreads)
    .leftJoin(users, eq(users.id, supportThreads.openedByUserId))
    .orderBy(desc(supportThreads.lastMessageAt), desc(supportThreads.id))
    .limit(limit);
  return rows.map(toThreadRecord);
}

/** One thread, if the transaction's member may read it. */
export async function findSupportThread(
  tx: TenantTx,
  id: string,
  reader: UserId | null,
): Promise<SupportThreadRecord | undefined> {
  const [row] = await tx
    .select(threadColumns(reader))
    .from(supportThreads)
    .leftJoin(users, eq(users.id, supportThreads.openedByUserId))
    .where(eq(supportThreads.id, Id.parse(id)))
    .limit(1);
  return row === undefined ? undefined : toThreadRecord(row);
}

/** Locks a thread for a reply or a status change; `undefined` if it isn't reachable. */
export async function lockSupportThread(
  tx: TenantTx,
  id: string,
): Promise<{ id: string; status: SupportStatus; reference: string } | undefined> {
  const [row] = await tx
    .select({
      id: supportThreads.id,
      status: supportThreads.status,
      reference: supportThreads.reference,
    })
    .from(supportThreads)
    .where(eq(supportThreads.id, Id.parse(id)))
    .for('update')
    .limit(1);
  return row === undefined ? undefined : { ...row, status: SupportStatusSchema.parse(row.status) };
}

/** A thread's messages, oldest first. */
export async function listSupportMessages(
  tx: TenantTx,
  threadId: string,
): Promise<SupportMessageRecord[]> {
  const rows = await tx
    .select({
      id: supportMessages.id,
      authorKind: supportMessages.authorKind,
      authorUserId: supportMessages.authorUserId,
      authorName: users.name,
      body: supportMessages.body,
      createdAt: supportMessages.createdAt,
    })
    .from(supportMessages)
    .leftJoin(users, eq(users.id, supportMessages.authorUserId))
    .where(eq(supportMessages.threadId, Id.parse(threadId)))
    .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
  return rows.map((row) => ({
    ...row,
    authorKind: row.authorKind === 'pepper' ? 'pepper' : 'member',
  }));
}

/**
 * Adds a message to a locked thread and moves it to `status` (its last message now). A
 * member's message has its writer; the team's has none.
 */
export async function appendSupportMessage(
  tx: TenantTx,
  input: {
    threadId: string;
    author: { kind: 'member'; userId: UserId } | { kind: 'pepper' };
    body: string;
    status: SupportStatus;
    now: Date;
  },
): Promise<{ id: string }> {
  const threadId = Id.parse(input.threadId);
  const [message] = await tx
    .insert(supportMessages)
    .values({
      threadId,
      authorKind: input.author.kind,
      authorUserId: input.author.kind === 'member' ? UserIdSchema.parse(input.author.userId) : null,
      body: input.body,
      createdAt: input.now,
    })
    .returning({ id: supportMessages.id });
  await setSupportThreadStatus(tx, threadId, input.status, input.now, { touched: true });
  if (message === undefined) throw new Error('The message was not written');
  return message;
}

/** Sets a thread's status (`solved_at` follows); `touched` also moves its last activity. */
export async function setSupportThreadStatus(
  tx: TenantTx,
  threadId: string,
  status: SupportStatus,
  now: Date,
  options: { touched?: boolean } = {},
): Promise<void> {
  await tx
    .update(supportThreads)
    .set({
      status: SupportStatusSchema.parse(status),
      solvedAt: status === 'solved' ? now : null,
      ...(options.touched === true && { lastMessageAt: now }),
    })
    .where(eq(supportThreads.id, Id.parse(threadId)));
}

/** Records that `userId` opened the thread at `now` (later opens move it forward only). */
export async function markSupportThreadRead(
  tx: TenantTx,
  threadId: string,
  userId: UserId,
  now: Date,
): Promise<void> {
  await tx
    .insert(supportReads)
    .values({ threadId: Id.parse(threadId), userId: UserIdSchema.parse(userId), readAt: now })
    .onConflictDoUpdate({
      target: [supportReads.threadId, supportReads.userId],
      set: { readAt: sql`GREATEST(${supportReads.readAt}, excluded.read_at)` },
    });
}

/** The reader's own threads with an unread answer from the team. */
export async function countUnreadSupportThreads(tx: TenantTx, reader: UserId): Promise<number> {
  const readerId = UserIdSchema.parse(reader);
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
      FROM support_threads t
     WHERE t.opened_by_user_id = ${readerId}
       AND EXISTS (
         SELECT 1 FROM support_messages m
          WHERE m.thread_id = t.id AND m.author_kind = 'pepper'
            AND m.created_at > COALESCE(
              (SELECT r.read_at FROM support_reads r WHERE r.thread_id = t.id AND r.user_id = ${readerId}),
              '-infinity'::timestamptz))`);
  return rows[0]?.count ?? 0;
}

/**
 * Holds `userId`'s support writes in the business until the transaction ends, so two requests
 * sent at once count each other against the day's limits (AC-X-14).
 */
export async function lockSupportWriter(tx: TenantTx, userId: UserId): Promise<void> {
  const id = UserIdSchema.parse(userId);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('support:' || current_tenant_id()::text || ':' || ${id}, 0))`,
  );
}

/** What `userId` wrote in the business since `since`: threads opened and messages. */
export async function countSupportWrites(
  tx: TenantTx,
  userId: UserId,
  since: Date,
): Promise<{ threads: number; messages: number }> {
  const id = UserIdSchema.parse(userId);
  const [threads] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(supportThreads)
    .where(and(eq(supportThreads.openedByUserId, id), gt(supportThreads.createdAt, since)));
  const [messages] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(supportMessages)
    .where(and(eq(supportMessages.authorUserId, id), gt(supportMessages.createdAt, since)));
  return { threads: threads?.count ?? 0, messages: messages?.count ?? 0 };
}

/** The transaction business's threads and their messages, for its export (ADR-0053). */
export async function listSupportForExport(tx: TenantTx): Promise<{
  threads: { id: string; reference: string; kind: string; status: string; createdAt: Date }[];
  messages: { threadId: string; authorKind: string; body: string; createdAt: Date }[];
}> {
  const threads = await tx
    .select({
      id: supportThreads.id,
      reference: supportThreads.reference,
      kind: supportThreads.kind,
      status: supportThreads.status,
      createdAt: supportThreads.createdAt,
    })
    .from(supportThreads)
    .orderBy(asc(supportThreads.createdAt), asc(supportThreads.id));
  const messages = await tx
    .select({
      threadId: supportMessages.threadId,
      authorKind: supportMessages.authorKind,
      body: supportMessages.body,
      createdAt: supportMessages.createdAt,
    })
    .from(supportMessages)
    .orderBy(asc(supportMessages.createdAt), asc(supportMessages.id));
  return { threads, messages };
}

/**
 * Stores a request from the public form (no business). `null` when `reference` is taken: the
 * caller draws another.
 */
export async function insertPublicSupportRequest(
  db: Database,
  input: {
    reference: string;
    email: string;
    name: string | null;
    body: string;
    page: string | null;
    topic: string | null;
    now: Date;
  },
): Promise<{ id: string } | null> {
  // No RETURNING and no ON CONFLICT: the form's role may insert a request but not read one
  // back, which both need (ADR-0062). A taken reference is a unique violation instead.
  const id = newId();
  try {
    await db.insert(publicSupportRequests).values({
      id,
      reference: SupportReferenceSchema.parse(input.reference),
      email: input.email,
      name: input.name,
      body: input.body,
      page: input.page,
      topic: input.topic,
      createdAt: input.now,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'public_support_requests_reference_unique')) return null;
    throw error;
  }
  return { id };
}

// The operator console (S59.2, ADR-0062). These run in `withOperator`, whose `operator_*`
// policies show support rows of every business; writes to a business's thread bind the
// transaction to that business first (`setTransactionTenant`) and go through its own policies.

/** A request in the console's inbox: a business's thread or a public one. */
export interface OperatorInboxRow {
  source: 'thread' | 'public';
  id: string;
  tenantId: string | null;
  reference: string;
  kind: SupportKind | null;
  status: string;
  preview: string;
  /** Since when it waits on whoever has to answer next (the oldest unanswered message). */
  waitingSince: Date;
  lastMessageAt: Date;
}

/** Business threads in `statuses`, the longest waiting first. */
export async function listOperatorThreads(
  tx: TenantTx,
  query: { statuses: readonly SupportStatus[]; limit: number },
): Promise<OperatorInboxRow[]> {
  const statuses = z.array(SupportStatusSchema).min(1).parse(query.statuses);
  const limit = z.number().int().min(1).max(500).parse(query.limit);
  const { rows } = await tx.execute<{
    id: string;
    tenant_id: string;
    reference: string;
    kind: string;
    status: string;
    preview: string | null;
    waiting_since: string;
    last_message_at: string;
  }>(sql`
    SELECT t.id, t.tenant_id, t.reference, t.kind, t.status, t.last_message_at,
           (SELECT left(m.body, ${sql.raw(String(PREVIEW_LENGTH))}) FROM support_messages m
             WHERE m.thread_id = t.id ORDER BY m.created_at, m.id LIMIT 1) AS preview,
           CASE WHEN t.status = 'waiting_on_pepper' THEN COALESCE(
             (SELECT min(m.created_at) FROM support_messages m
               WHERE m.thread_id = t.id AND m.author_kind = 'member'
                 AND m.created_at > COALESCE(
                   (SELECT max(p.created_at) FROM support_messages p
                     WHERE p.thread_id = t.id AND p.author_kind = 'pepper'),
                   '-infinity'::timestamptz)),
             t.created_at)
           ELSE t.last_message_at END AS waiting_since
      FROM support_threads t
     WHERE t.status IN (${sql.join(
       statuses.map((status) => sql`${status}`),
       sql`, `,
     )})
     ORDER BY waiting_since, t.id
     LIMIT ${limit}`);
  return rows.map((row) => ({
    source: 'thread',
    id: row.id,
    tenantId: row.tenant_id,
    reference: row.reference,
    kind: SupportKindSchema.parse(row.kind),
    status: SupportStatusSchema.parse(row.status),
    preview: row.preview ?? '',
    waitingSince: new Date(row.waiting_since),
    lastMessageAt: new Date(row.last_message_at),
  }));
}

/** Public requests in `statuses`, the longest waiting first. */
export async function listOperatorPublicRequests(
  tx: TenantTx,
  query: { statuses: readonly PublicSupportStatus[]; limit: number },
): Promise<OperatorInboxRow[]> {
  const statuses = z.array(PublicSupportStatusSchema).min(1).parse(query.statuses);
  const limit = z.number().int().min(1).max(500).parse(query.limit);
  const waitingSince = sql<Date>`COALESCE(${publicSupportRequests.statusChangedAt}, ${publicSupportRequests.createdAt})`;
  const rows = await tx
    .select({
      id: publicSupportRequests.id,
      reference: publicSupportRequests.reference,
      status: publicSupportRequests.status,
      preview: sql<string>`left(${publicSupportRequests.body}, ${sql.raw(String(PREVIEW_LENGTH))})`,
      createdAt: publicSupportRequests.createdAt,
      statusChangedAt: publicSupportRequests.statusChangedAt,
    })
    .from(publicSupportRequests)
    .where(inArray(publicSupportRequests.status, statuses))
    .orderBy(asc(waitingSince), asc(publicSupportRequests.id))
    .limit(limit);
  return rows.map((row) => ({
    source: 'public',
    id: row.id,
    tenantId: null,
    reference: row.reference,
    kind: null,
    status: PublicSupportStatusSchema.parse(row.status),
    preview: row.preview,
    waitingSince: row.statusChangedAt ?? row.createdAt,
    lastMessageAt: row.statusChangedAt ?? row.createdAt,
  }));
}

/** The businesses' names for the inbox (`operator_business_names`: nothing else of them). */
export async function listOperatorBusinessNames(
  tx: TenantTx,
  tenantIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = z
    .array(Id)
    .max(500)
    .parse([...new Set(tenantIds)]);
  if (ids.length === 0) return new Map();
  const { rows } = await tx.execute<{ id: string; name: string }>(
    sql`SELECT id, name FROM operator_business_names(${`{${ids.join(',')}}`}::uuid[])`,
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** One thread as the console opens it: with its business and the opener's role. */
export interface OperatorThreadRecord extends SupportThreadRecord {
  tenantId: string;
  openedByRole: string | null;
  pepperSeenAt: Date | null;
}

export async function findOperatorThread(
  tx: TenantTx,
  id: string,
): Promise<OperatorThreadRecord | undefined> {
  const [row] = await tx
    .select({
      ...threadColumns(null),
      tenantId: supportThreads.tenantId,
      pepperSeenAt: supportThreads.pepperSeenAt,
    })
    .from(supportThreads)
    .leftJoin(users, eq(users.id, supportThreads.openedByUserId))
    .where(eq(supportThreads.id, Id.parse(id)))
    .limit(1);
  if (row === undefined) return undefined;
  const { tenantId, pepperSeenAt, ...thread } = row;
  return { ...toThreadRecord(thread), tenantId, pepperSeenAt, openedByRole: null };
}

/** The opener's role in the business; run bound to the thread's business. */
export async function findSupportOpenerRole(
  tx: TenantTx,
  userId: string | null,
): Promise<string | null> {
  if (userId === null) return null;
  const [row] = await tx
    .select({ role: memberships.role })
    .from(memberships)
    .where(eq(memberships.userId, Id.parse(userId)))
    .limit(1);
  return row?.role ?? null;
}

/** Records that Pepper opened the thread (bound to its business). */
export async function markSupportThreadSeenByPepper(
  tx: TenantTx,
  threadId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(supportThreads)
    .set({ pepperSeenAt: now })
    .where(eq(supportThreads.id, Id.parse(threadId)));
}

/** When Pepper last opened a thread the transaction's member may read. */
export async function findSupportThreadSeenAt(
  tx: TenantTx,
  threadId: string,
): Promise<Date | null> {
  const [row] = await tx
    .select({ seenAt: supportThreads.pepperSeenAt })
    .from(supportThreads)
    .where(eq(supportThreads.id, Id.parse(threadId)))
    .limit(1);
  return row?.seenAt ?? null;
}

export interface PublicSupportRequestRecord {
  id: string;
  reference: string;
  email: string;
  name: string | null;
  body: string;
  page: string | null;
  topic: string | null;
  status: PublicSupportStatus;
  createdAt: Date;
  statusChangedAt: Date | null;
}

/** One public request; `lock` holds it for a status change. */
export async function findPublicSupportRequest(
  tx: TenantTx,
  id: string,
  options: { lock?: boolean } = {},
): Promise<PublicSupportRequestRecord | undefined> {
  const query = tx
    .select({
      id: publicSupportRequests.id,
      reference: publicSupportRequests.reference,
      email: publicSupportRequests.email,
      name: publicSupportRequests.name,
      body: publicSupportRequests.body,
      page: publicSupportRequests.page,
      topic: publicSupportRequests.topic,
      status: publicSupportRequests.status,
      createdAt: publicSupportRequests.createdAt,
      statusChangedAt: publicSupportRequests.statusChangedAt,
    })
    .from(publicSupportRequests)
    .where(eq(publicSupportRequests.id, Id.parse(id)))
    .limit(1);
  const [row] = options.lock === true ? await query.for('update') : await query;
  return row === undefined
    ? undefined
    : { ...row, status: PublicSupportStatusSchema.parse(row.status) };
}

export async function setPublicSupportRequestStatus(
  tx: TenantTx,
  id: string,
  status: PublicSupportStatus,
  now: Date,
): Promise<void> {
  await tx
    .update(publicSupportRequests)
    .set({ status: PublicSupportStatusSchema.parse(status), statusChangedAt: now })
    .where(eq(publicSupportRequests.id, Id.parse(id)));
}

export interface SupportNoteRecord {
  id: string;
  authorUserId: string | null;
  authorName: string | null;
  body: string;
  createdAt: Date;
}

type NoteTarget = { threadId: string } | { publicRequestId: string };

/** The team's notes on a request, oldest first (an operator transaction only). */
export async function listSupportNotes(
  tx: TenantTx,
  target: NoteTarget,
): Promise<SupportNoteRecord[]> {
  return tx
    .select({
      id: supportNotes.id,
      authorUserId: supportNotes.authorUserId,
      authorName: users.name,
      body: supportNotes.body,
      createdAt: supportNotes.createdAt,
    })
    .from(supportNotes)
    .leftJoin(users, eq(users.id, supportNotes.authorUserId))
    .where(
      'threadId' in target
        ? eq(supportNotes.threadId, Id.parse(target.threadId))
        : eq(supportNotes.publicRequestId, Id.parse(target.publicRequestId)),
    )
    .orderBy(asc(supportNotes.createdAt), asc(supportNotes.id));
}

export async function insertSupportNote(
  tx: TenantTx,
  input: NoteTarget & { authorUserId: UserId; body: string; now: Date },
): Promise<{ id: string }> {
  const id = newId();
  await tx.insert(supportNotes).values({
    id,
    ...('threadId' in input
      ? { threadId: Id.parse(input.threadId) }
      : { publicRequestId: Id.parse(input.publicRequestId) }),
    authorUserId: UserIdSchema.parse(input.authorUserId),
    body: input.body,
    createdAt: input.now,
  });
  return { id };
}
