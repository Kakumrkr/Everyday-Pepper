import {
  PublicSupportStatusSchema,
  SupportKindSchema,
  SupportReferenceSchema,
  SupportStatusSchema,
  UserIdSchema,
  SupportRatingSchema,
  SupportSolvedBySchema,
  type PublicSupportStatus,
  type SupportKind,
  type SupportRating,
  type SupportSolvedBy,
  type SupportStatus,
  type UserId,
} from '@pepper/contracts';
import { and, asc, count, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  memberships,
  publicSupportRequests,
  supportMessages,
  supportNotes,
  supportReads,
  supportSavedReplies,
  supportThreads,
  users,
} from '../schema.js';
import { isUniqueViolation } from '../errors.js';
import { newId } from '../ids.js';
import { withJobScan, type TenantTx } from '../tenant.js';

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
  /** When the Pepper team last opened it (S59.2). */
  pepperSeenAt: Date | null;
  /** Who solved it (S59.2.2): `null` while it is open. */
  solvedBy: SupportSolvedBy | null;
  /** The opener's answer to "Did this help?" (S59.2.2, AC-X-26). */
  rating: SupportRating | null;
  /** The team answered after the reader last opened it (the reader's own threads only). */
  unread: boolean;
  /** How many screenshots its messages carry (S59.2.3, AC-X-27/30). */
  screenshotCount: number;
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
    pepperSeenAt: supportThreads.pepperSeenAt,
    solvedBy: supportThreads.solvedBy,
    rating: supportThreads.rating,
    preview: sql<string>`(SELECT left(m.body, ${sql.raw(String(PREVIEW_LENGTH))}) FROM support_messages m WHERE m.thread_id = ${supportThreads.id} ORDER BY m.created_at, m.id LIMIT 1)`,
    screenshotCount: sql<number>`(SELECT count(*)::int FROM support_screenshots s WHERE s.thread_id = ${supportThreads.id})`,
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
  pepperSeenAt: Date | null;
  solvedBy: string | null;
  rating: string | null;
  preview: string | null;
  unread: boolean | null;
  screenshotCount: number | null;
}): SupportThreadRecord {
  return {
    ...row,
    kind: SupportKindSchema.parse(row.kind),
    status: SupportStatusSchema.parse(row.status),
    solvedBy: row.solvedBy === null ? null : SupportSolvedBySchema.parse(row.solvedBy),
    rating: row.rating === null ? null : SupportRatingSchema.parse(row.rating),
    preview: row.preview ?? '',
    unread: row.unread === true,
    screenshotCount: row.screenshotCount ?? 0,
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

/**
 * Sets a thread's status (`solved_at` and who solved it follow; any other status clears the
 * opener's rating, S59.2.2); `touched` also moves its last activity.
 */
export async function setSupportThreadStatus(
  tx: TenantTx,
  threadId: string,
  status: SupportStatus,
  now: Date,
  options: { touched?: boolean; solvedBy?: SupportSolvedBy } = {},
): Promise<void> {
  const solved = SupportStatusSchema.parse(status) === 'solved';
  await tx
    .update(supportThreads)
    .set({
      status,
      // Only a change of status: a member's second message while waiting starts no new wait.
      statusChangedAt: sql`CASE WHEN ${supportThreads.status} = ${status} THEN ${supportThreads.statusChangedAt} ELSE ${now.toISOString()}::timestamptz END`,
      solvedAt: solved ? now : null,
      solvedBy: solved ? SupportSolvedBySchema.parse(options.solvedBy ?? 'member') : null,
      ...(!solved && { rating: null, ratedAt: null }),
      ...(options.touched === true && { lastMessageAt: now }),
    })
    .where(eq(supportThreads.id, Id.parse(threadId)));
}

/** The opener's answer to "Did this help?" on a solved, locked thread (S59.2.2, AC-X-26). */
export async function setSupportThreadRating(
  tx: TenantTx,
  threadId: string,
  rating: SupportRating,
  now: Date,
): Promise<void> {
  await tx
    .update(supportThreads)
    .set({ rating: SupportRatingSchema.parse(rating), ratedAt: now })
    .where(eq(supportThreads.id, Id.parse(threadId)));
}

/**
 * Since when a thread waits on whoever answers next (`t` is the thread): waiting on Pepper,
 * the member's oldest message after the team last wrote and since it last became "waiting"
 * (a reopened request starts a new wait, S59.2.2); moved back to waiting by the team with
 * nothing new, since the team last wrote; else since it opened. Otherwise its last message.
 */
const WAITING_SINCE = sql.raw(`CASE WHEN t.status = 'waiting_on_pepper' THEN COALESCE(
  (SELECT min(m.created_at) FROM support_messages m
    WHERE m.thread_id = t.id AND m.author_kind = 'member'
      AND m.created_at > COALESCE(
        (SELECT max(p.created_at) FROM support_messages p
          WHERE p.thread_id = t.id AND p.author_kind = 'pepper'),
        '-infinity'::timestamptz)
      AND m.created_at >= COALESCE(t.status_changed_at, '-infinity'::timestamptz)),
  (SELECT max(p.created_at) FROM support_messages p
    WHERE p.thread_id = t.id AND p.author_kind = 'pepper'),
  t.created_at)
ELSE t.last_message_at END`);

/** Since when a thread has been quiet: its last message or status change, the later. */
const QUIET_SINCE = sql.raw(`GREATEST(t.last_message_at, t.status_changed_at)`);

/** A thread the support job has to look at (S59.2.2, AC-X-24/25). */
export interface SupportDueThread {
  tenantId: string;
  threadId: string;
}

/**
 * Across businesses (`withJobScan('support')`): threads waiting on Pepper since `overdueBefore`
 * whose wait hasn't been reminded, and threads the team answered that have been quiet since
 * `quietBefore`. Ids only; each is checked again under its lock, bound to its business.
 */
export async function listDueSupportThreads(
  db: Database,
  query: { overdueBefore: Date; quietBefore: Date; limit: number },
): Promise<SupportDueThread[]> {
  const limit = z.number().int().min(1).max(1000).parse(query.limit);
  return withJobScan(db, 'support', async (tx) => {
    const { rows } = await tx.execute<{ tenant_id: string; id: string }>(sql`
      SELECT tenant_id, id FROM (
        SELECT t.tenant_id, t.id, t.created_at, ${WAITING_SINCE} AS waiting_since,
               t.overdue_reminded_at
          FROM support_threads t
         WHERE t.status = 'waiting_on_pepper'
      ) w
       WHERE w.waiting_since <= ${query.overdueBefore.toISOString()}::timestamptz
         AND (w.overdue_reminded_at IS NULL OR w.overdue_reminded_at < w.waiting_since)
      UNION
      SELECT t.tenant_id, t.id FROM support_threads t
       WHERE t.status = 'pepper_replied'
         AND ${QUIET_SINCE} <= ${query.quietBefore.toISOString()}::timestamptz
      ORDER BY id
      LIMIT ${limit}`);
    return rows.map((row) => ({ tenantId: row.tenant_id, threadId: row.id }));
  });
}

/** A thread as the support job checks it, locked (bound to its business). */
export interface SupportThreadDue {
  id: string;
  reference: string;
  kind: SupportKind;
  status: SupportStatus;
  openedByUserId: string | null;
  waitingSince: Date;
  quietSince: Date;
  overdueRemindedAt: Date | null;
}

export async function lockDueSupportThread(
  tx: TenantTx,
  id: string,
): Promise<SupportThreadDue | undefined> {
  const threadId = Id.parse(id);
  // Locked first, then read with its waiting time, which a statement with FOR UPDATE can't
  // compute (aggregates).
  if ((await lockSupportThread(tx, threadId)) === undefined) return undefined;
  const { rows } = await tx.execute<{
    id: string;
    reference: string;
    kind: string;
    status: string;
    opened_by_user_id: string | null;
    waiting_since: string;
    quiet_since: string;
    overdue_reminded_at: string | null;
  }>(sql`
    SELECT t.id, t.reference, t.kind, t.status, t.opened_by_user_id,
           ${WAITING_SINCE} AS waiting_since, ${QUIET_SINCE} AS quiet_since,
           t.overdue_reminded_at
      FROM support_threads t WHERE t.id = ${threadId}`);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    reference: row.reference,
    kind: SupportKindSchema.parse(row.kind),
    status: SupportStatusSchema.parse(row.status),
    openedByUserId: row.opened_by_user_id,
    waitingSince: new Date(row.waiting_since),
    quietSince: new Date(row.quiet_since),
    overdueRemindedAt: row.overdue_reminded_at === null ? null : new Date(row.overdue_reminded_at),
  };
}

/** Records that the team's address was reminded of the thread's current wait. */
export async function markSupportThreadReminded(
  tx: TenantTx,
  threadId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(supportThreads)
    .set({ overdueRemindedAt: now })
    .where(eq(supportThreads.id, Id.parse(threadId)));
}

/**
 * Solves the public requests answered and quiet for 7 days (`support_public_close_quiet`, the
 * window fixed in the database); `now` may not run ahead of its clock. Returns how many.
 */
export async function closeQuietPublicSupportRequests(db: Database, now: Date): Promise<number> {
  const { rows } = await db.execute<{ closed: number }>(
    sql`SELECT support_public_close_quiet(${now.toISOString()}::timestamptz) AS closed`,
  );
  return rows[0]?.closed ?? 0;
}

/** An open public request waiting 4 h or more, not reminded of this wait (AC-X-25). */
export interface PublicSupportOverdue {
  id: string;
  reference: string;
  waitingSince: Date;
}

export async function listOverduePublicSupportRequests(
  db: Database,
  now: Date,
  limit: number,
): Promise<PublicSupportOverdue[]> {
  const { rows } = await db.execute<{ id: string; reference: string; waiting_since: string }>(
    sql`SELECT id, reference, waiting_since
          FROM support_public_overdue(${now.toISOString()}::timestamptz, ${z.number().int().min(1).max(1000).parse(limit)})`,
  );
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    waitingSince: new Date(row.waiting_since),
  }));
}

/**
 * Marks one public request reminded, if it still is overdue and unreminded; `false` otherwise.
 * In the caller's transaction, so the email sent in it can undo the mark.
 */
export async function markPublicSupportRequestReminded(
  tx: TenantTx,
  id: string,
  now: Date,
): Promise<boolean> {
  const { rows } = await tx.execute<{ marked: boolean }>(
    sql`SELECT support_public_mark_reminded(${Id.parse(id)}::uuid, ${now.toISOString()}::timestamptz) AS marked`,
  );
  return rows[0]?.marked === true;
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
  messages: { id: string; threadId: string; authorKind: string; body: string; createdAt: Date }[];
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
      id: supportMessages.id,
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
  /** The opener's "Did this help?" (business threads, S59.2.2). */
  rating: SupportRating | null;
  /** How many screenshots it carries (S59.2.3's top-up, AC-X-30); public requests have none. */
  screenshotCount: number;
}

/**
 * Business threads in `statuses`: the longest waiting first, or (`newestFirst`, the answered
 * and solved views) the latest activity first, so the newest are never cut by the limit.
 */
export async function listOperatorThreads(
  tx: TenantTx,
  query: { statuses: readonly SupportStatus[]; limit: number; newestFirst?: boolean },
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
    rating: string | null;
    screenshot_count: number;
  }>(sql`
    SELECT t.id, t.tenant_id, t.reference, t.kind, t.status, t.last_message_at, t.rating,
           (SELECT count(*)::int FROM support_screenshots s WHERE s.thread_id = t.id)
             AS screenshot_count,
           (SELECT left(m.body, ${sql.raw(String(PREVIEW_LENGTH))}) FROM support_messages m
             WHERE m.thread_id = t.id ORDER BY m.created_at, m.id LIMIT 1) AS preview,
           ${WAITING_SINCE} AS waiting_since
      FROM support_threads t
     WHERE t.status IN (${sql.join(
       statuses.map((status) => sql`${status}`),
       sql`, `,
     )})
     ORDER BY ${query.newestFirst === true ? sql`waiting_since DESC, t.id DESC` : sql`waiting_since, t.id`}
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
    rating: row.rating === null ? null : SupportRatingSchema.parse(row.rating),
    screenshotCount: row.screenshot_count,
  }));
}

/** Public requests in `statuses`, ordered as `listOperatorThreads`. */
export async function listOperatorPublicRequests(
  tx: TenantTx,
  query: { statuses: readonly PublicSupportStatus[]; limit: number; newestFirst?: boolean },
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
    .orderBy(
      ...(query.newestFirst === true
        ? [desc(waitingSince), desc(publicSupportRequests.id)]
        : [asc(waitingSince), asc(publicSupportRequests.id)]),
    )
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
    rating: null,
    screenshotCount: 0,
  }));
}

/** How many requests wait on the team: business threads and public requests. */
export async function countOperatorWaiting(tx: TenantTx): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(sql`
    SELECT (SELECT count(*) FROM support_threads WHERE status = 'waiting_on_pepper')::int
         + (SELECT count(*) FROM public_support_requests WHERE status = 'open')::int AS count`);
  return rows[0]?.count ?? 0;
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
}

export async function findOperatorThread(
  tx: TenantTx,
  id: string,
): Promise<OperatorThreadRecord | undefined> {
  const [row] = await tx
    .select({ ...threadColumns(null), tenantId: supportThreads.tenantId })
    .from(supportThreads)
    .leftJoin(users, eq(users.id, supportThreads.openedByUserId))
    .where(eq(supportThreads.id, Id.parse(id)))
    .limit(1);
  if (row === undefined) return undefined;
  const { tenantId, ...thread } = row;
  return { ...toThreadRecord(thread), tenantId };
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

/** A saved reply of the team's (S59.2.2, AC-X-23). */
export interface SupportSavedReplyRecord {
  id: string;
  title: string;
  body: string;
  updatedAt: Date;
}

const savedReplyColumns = {
  id: supportSavedReplies.id,
  title: supportSavedReplies.title,
  body: supportSavedReplies.body,
  updatedAt: supportSavedReplies.updatedAt,
};

/** The saved replies by title (an operator transaction only). */
export async function listSupportSavedReplies(tx: TenantTx): Promise<SupportSavedReplyRecord[]> {
  return tx
    .select(savedReplyColumns)
    .from(supportSavedReplies)
    .orderBy(asc(supportSavedReplies.title), asc(supportSavedReplies.id));
}

/** Holds the saved replies' limit for this transaction (a second add waits, then counts). */
export async function lockSupportSavedReplies(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('support_saved_replies', 0))`);
}

export async function countSupportSavedReplies(tx: TenantTx): Promise<number> {
  const [row] = await tx.select({ count: count() }).from(supportSavedReplies);
  return row?.count ?? 0;
}

export async function insertSupportSavedReply(
  tx: TenantTx,
  input: { title: string; body: string; updatedByUserId: UserId; now: Date },
): Promise<SupportSavedReplyRecord> {
  const [row] = await tx
    .insert(supportSavedReplies)
    .values({
      title: input.title,
      body: input.body,
      updatedByUserId: UserIdSchema.parse(input.updatedByUserId),
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning(savedReplyColumns);
  if (row === undefined) throw new Error('The saved reply was not written');
  return row;
}

/** `undefined` when there is no such saved reply. */
export async function updateSupportSavedReply(
  tx: TenantTx,
  id: string,
  input: { title: string; body: string; updatedByUserId: UserId },
): Promise<SupportSavedReplyRecord | undefined> {
  const [row] = await tx
    .update(supportSavedReplies)
    .set({
      title: input.title,
      body: input.body,
      updatedByUserId: UserIdSchema.parse(input.updatedByUserId),
    })
    .where(eq(supportSavedReplies.id, Id.parse(id)))
    .returning(savedReplyColumns);
  return row;
}

/** Whether a saved reply was deleted. */
export async function deleteSupportSavedReply(tx: TenantTx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(supportSavedReplies)
    .where(eq(supportSavedReplies.id, Id.parse(id)))
    .returning({ id: supportSavedReplies.id });
  return rows.length > 0;
}
