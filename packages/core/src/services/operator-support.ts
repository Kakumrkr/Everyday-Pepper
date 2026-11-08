import {
  OperatorInboxQuerySchema,
  OperatorInboxSchema,
  OperatorPublicChangeSchema,
  OperatorPublicRequestSchema,
  OperatorThreadChangeSchema,
  OperatorThreadSchema,
  PublicSupportRequestIdSchema,
  SupportContextSchema,
  SupportNoteInputSchema,
  SupportReplyInputSchema,
  SUPPORT_SAVED_REPLIES_MAX,
  SupportSavedReplyIdSchema,
  SupportSavedReplyInputSchema,
  SupportSavedReplyListSchema,
  SupportSavedReplySchema,
  SupportScreenshotIdSchema,
  SupportThreadIdSchema,
  type OperatorInbox,
  type OperatorInboxQuery,
  type OperatorInboxView,
  type OperatorPublicChange,
  type OperatorPublicRequest,
  type OperatorThread,
  type OperatorThreadChange,
  type PublicSupportStatus,
  type SupportNote,
  type SupportNoteInput,
  type SupportReplyInput,
  type SupportSavedReply,
  type SupportSavedReplyInput,
  type SupportSavedReplyList,
  type SupportScreenshotSize,
  type SupportStatus,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  countOperatorWaiting,
  countSupportSavedReplies,
  deleteSupportSavedReply,
  insertSupportSavedReply,
  listSupportSavedReplies,
  lockSupportSavedReplies,
  updateSupportSavedReply,
  findOperatorThread,
  findSupportScreenshot,
  findPublicSupportRequest,
  findSupportOpenerRole,
  insertSupportNote,
  isPlatformOperator,
  isPolicyViolation,
  listOperatorBusinessNames,
  listOperatorPublicRequests,
  listOperatorThreads,
  listSupportMessages,
  listSupportNotes,
  lockSupportThread,
  markSupportThreadSeenByPepper,
  setPublicSupportRequestStatus,
  setSupportThreadStatus,
  setTransactionTenant,
  withOperator,
  type Database,
  type OperatorAction,
  type OperatorInboxRow,
  type OperatorThreadRecord,
  type SupportNoteRecord,
  type SupportSavedReplyRecord,
  type TenantTx,
} from '@pepper/db';
import { systemClock, type Clock } from '../clock.js';
import {
  OperatorAccessRefusedError,
  SavedRepliesFullError,
  SavedReplyNotFoundError,
  SupportScreenshotNotFoundError,
  SupportScreenshotsNotAttachableError,
  SupportThreadNotFoundError,
} from '../errors.js';
import { answerInThread, type SupportOptions } from './support.js';
import {
  imageOf,
  screenshotsByMessage,
  type ScreenshotImage,
  type ScreenshotOptions,
} from './support-screenshots.js';

// Pepper's support console (S59.2, ADR-0062, AC-X-19…22). Only accounts holding the operator
// grant (the `operator` script) get here, and each call is one `withOperator` transaction whose
// access log row the database requires before it shows any support row across businesses. A
// change to a business's thread binds the transaction to that business first and writes the
// business's audit log as `operator` (never the person). The team's notes are never shown to
// a member. Message text is never logged or audited.

/** The operator, as `OperatorGuard` resolved them from the session. */
export interface Operator {
  userId: UserId;
}

const INBOX_LIMIT = 200;
/** A business's audit log gets one `seen` an hour per thread, or after a new message. */
const SEEN_AGAIN_MS = 60 * 60 * 1000;

/**
 * `withOperator` for the console: a grant revoked since `OperatorGuard` looked is
 * `OperatorAccessRefusedError` (403), not a database error.
 */
async function asOperator<T>(
  db: Database,
  operator: Operator,
  action: OperatorAction,
  targetId: string | null,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  // Set once the access is open: a refusal before it is the grant's, after it the work's.
  const access = { begun: false };
  try {
    return await withOperator(db, { operatorUserId: operator.userId, action, targetId }, (tx) => {
      access.begun = true;
      return work(tx);
    });
  } catch (error) {
    if (!access.begun && isPolicyViolation(error)) throw new OperatorAccessRefusedError();
    throw error;
  }
}

const THREAD_STATUSES: Readonly<Record<OperatorInboxView, readonly SupportStatus[]>> = {
  waiting: ['waiting_on_pepper'],
  answered: ['pepper_replied'],
  solved: ['solved'],
};
const PUBLIC_STATUSES: Readonly<Record<OperatorInboxView, readonly PublicSupportStatus[]>> = {
  waiting: ['open'],
  answered: ['answered'],
  solved: ['solved'],
};

/** Whether the signed-in account may open the console (AC-X-19). */
export async function isOperator(db: Database, userId: UserId): Promise<boolean> {
  return isPlatformOperator(db, userId);
}

/**
 * The inbox (AC-X-20): the view's business threads and public requests together. Waiting: the
 * one that has waited longest first. Answered and solved: the latest first. `waiting` counts
 * what waits on Pepper whatever the view.
 */
export async function readOperatorInbox(
  db: Database,
  operator: Operator,
  query: OperatorInboxQuery,
): Promise<OperatorInbox> {
  const { view } = OperatorInboxQuerySchema.parse(query);
  return asOperator(db, operator, 'inbox.read', null, async (tx) => {
    const newestFirst = view !== 'waiting';
    const found = [
      ...(await listOperatorThreads(tx, {
        statuses: THREAD_STATUSES[view],
        limit: INBOX_LIMIT,
        newestFirst,
      })),
      ...(await listOperatorPublicRequests(tx, {
        statuses: PUBLIC_STATUSES[view],
        limit: INBOX_LIMIT,
        newestFirst,
      })),
    ];
    const rows = (newestFirst ? sortOldestFirst(found).reverse() : sortOldestFirst(found)).slice(
      0,
      INBOX_LIMIT,
    );
    const names = await listOperatorBusinessNames(
      tx,
      rows.flatMap((row) => (row.tenantId === null ? [] : [row.tenantId])),
    );
    const waiting = await countOperatorWaiting(tx);
    return OperatorInboxSchema.parse({
      view,
      items: rows.map((row) => toInboxItem(row, names)),
      waiting,
    });
  });
}

/** The longest waiting first; ties by reference, so the order is stable. */
export function sortOldestFirst<T extends { waitingSince: Date; reference: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) =>
      a.waitingSince.getTime() - b.waitingSince.getTime() || a.reference.localeCompare(b.reference),
  );
}

/** An inbox row as the contract's input; `OperatorInboxSchema` checks it. */
function toInboxItem(row: OperatorInboxRow, names: Map<string, string>): Record<string, unknown> {
  const base = {
    id: row.id,
    reference: row.reference,
    preview: row.preview,
    waitingSince: row.waitingSince.toISOString(),
  };
  if (row.source === 'public') {
    return { ...base, source: 'public', status: row.status };
  }
  return {
    ...base,
    source: 'thread',
    status: row.status,
    rating: row.rating,
    screenshotCount: row.screenshotCount,
    kind: row.kind,
    business: (row.tenantId === null ? undefined : names.get(row.tenantId)) ?? 'A business',
  };
}

/**
 * A business's request as the console opens it (AC-X-21/22): its messages, the team's notes,
 * what it was sent with. Opening it records "Seen by Pepper" on the thread and a `seen` entry
 * in the business's audit log.
 */
export async function readOperatorThread(
  db: Database,
  operator: Operator,
  threadId: string,
  options: { clock?: Clock } = {},
): Promise<OperatorThread> {
  const id = parseThreadId(threadId);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'thread.read', id, async (tx) => {
    const thread = await bindToThread(tx, id);
    if (seenAgain(thread, now)) {
      await markSupportThreadSeenByPepper(tx, id, now);
      await appendAuditEntry(tx, {
        actor: { kind: 'operator' },
        change: {
          action: 'support_thread.seen',
          entity: { type: 'support_thread', id },
          before: null,
          after: null,
        },
      });
    }
    return toOperatorThread(tx, id, thread.tenantId);
  });
}

/** The team's reply from the console (AC-X-21): as AC-X-16, the actor `operator`. */
export async function replyAsOperator(
  db: Database,
  operator: Operator,
  threadId: string,
  input: SupportReplyInput,
  options: SupportOptions,
): Promise<OperatorThread> {
  const id = parseThreadId(threadId);
  const { message, screenshotIds } = SupportReplyInputSchema.parse(input);
  // The team doesn't attach screenshots (S59.2.3): only members do.
  if (screenshotIds.length > 0) throw new SupportScreenshotsNotAttachableError();
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'thread.reply', id, async (tx) => {
    const { tenantId } = await bindToThread(tx, id);
    await answerInThread(tx, id, message, { kind: 'operator' }, options, now);
    await markSupportThreadSeenByPepper(tx, id, now);
    return toOperatorThread(tx, id, tenantId);
  });
}

/**
 * A screenshot's image for the console (AC-X-30): one `screenshot.read` row in the operator
 * access log per image served, in the transaction that finds it (the database shows a sent
 * screenshot to an operator only then). The image is read from storage once the row is in.
 */
export async function readOperatorScreenshotImage(
  db: Database,
  operator: Operator,
  screenshotId: string,
  size: SupportScreenshotSize,
  options: ScreenshotOptions,
): Promise<ScreenshotImage> {
  const parsed = SupportScreenshotIdSchema.safeParse(screenshotId);
  if (!parsed.success) throw new SupportScreenshotNotFoundError();
  const row = await asOperator(db, operator, 'screenshot.read', parsed.data, (tx) =>
    findSupportScreenshot(tx, parsed.data),
  );
  return imageOf(row, size, options.store);
}

/** Moves a business's request to any status (AC-X-21); the same status changes nothing. */
export async function setThreadStatusAsOperator(
  db: Database,
  operator: Operator,
  threadId: string,
  input: OperatorThreadChange,
  options: { clock?: Clock } = {},
): Promise<OperatorThread> {
  const id = parseThreadId(threadId);
  const { status } = OperatorThreadChangeSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'thread.status', id, async (tx) => {
    const { tenantId } = await bindToThread(tx, id);
    const thread = await lockSupportThread(tx, id);
    if (thread === undefined) throw new SupportThreadNotFoundError();
    if (thread.status !== status) {
      await setSupportThreadStatus(tx, id, status, now, { solvedBy: 'pepper' });
      await appendAuditEntry(tx, {
        actor: { kind: 'operator' },
        change: {
          action: 'support_thread.status_changed',
          entity: { type: 'support_thread', id },
          before: { status: thread.status },
          after: { status },
        },
      });
    }
    return toOperatorThread(tx, id, tenantId);
  });
}

/** A note of the team's on a business's request (AC-X-21): never shown to its members. */
export async function noteOnThread(
  db: Database,
  operator: Operator,
  threadId: string,
  input: SupportNoteInput,
  options: { clock?: Clock } = {},
): Promise<OperatorThread> {
  const id = parseThreadId(threadId);
  const { note } = SupportNoteInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'thread.note', id, async (tx) => {
    const { tenantId } = await bindToThread(tx, id);
    await insertSupportNote(tx, {
      threadId: id,
      authorUserId: operator.userId,
      body: note,
      now,
    });
    return toOperatorThread(tx, id, tenantId);
  });
}

/** A public request (AC-X-21). */
export async function readPublicRequest(
  db: Database,
  operator: Operator,
  requestId: string,
): Promise<OperatorPublicRequest> {
  const id = parsePublicId(requestId);
  return asOperator(db, operator, 'public.read', id, (tx) => toPublicRequest(tx, id));
}

/** Moves a public request to any status (AC-X-21): "answered" once the team wrote back. */
export async function setPublicStatusAsOperator(
  db: Database,
  operator: Operator,
  requestId: string,
  input: OperatorPublicChange,
  options: { clock?: Clock } = {},
): Promise<OperatorPublicRequest> {
  const id = parsePublicId(requestId);
  const { status } = OperatorPublicChangeSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'public.status', id, async (tx) => {
    const request = await findPublicSupportRequest(tx, id, { lock: true });
    if (request === undefined) throw new SupportThreadNotFoundError();
    if (request.status !== status) await setPublicSupportRequestStatus(tx, id, status, now);
    return toPublicRequest(tx, id);
  });
}

/** A note of the team's on a public request (AC-X-21). */
export async function noteOnPublicRequest(
  db: Database,
  operator: Operator,
  requestId: string,
  input: SupportNoteInput,
  options: { clock?: Clock } = {},
): Promise<OperatorPublicRequest> {
  const id = parsePublicId(requestId);
  const { note } = SupportNoteInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'public.note', id, async (tx) => {
    if ((await findPublicSupportRequest(tx, id)) === undefined) {
      throw new SupportThreadNotFoundError();
    }
    await insertSupportNote(tx, {
      publicRequestId: id,
      authorUserId: operator.userId,
      body: note,
      now,
    });
    return toPublicRequest(tx, id);
  });
}

/** The team's saved replies, by title (AC-X-23). */
export async function listSavedReplies(
  db: Database,
  operator: Operator,
): Promise<SupportSavedReplyList> {
  return asOperator(db, operator, 'replies.read', null, async (tx) =>
    SupportSavedReplyListSchema.parse({
      replies: (await listSupportSavedReplies(tx)).map(toSavedReply),
    }),
  );
}

/** Adds a saved reply (AC-X-23): at most `SUPPORT_SAVED_REPLIES_MAX`. */
export async function addSavedReply(
  db: Database,
  operator: Operator,
  input: SupportSavedReplyInput,
  options: { clock?: Clock } = {},
): Promise<SupportSavedReply> {
  const { title, body } = SupportSavedReplyInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return asOperator(db, operator, 'replies.write', null, async (tx) => {
    await lockSupportSavedReplies(tx);
    if ((await countSupportSavedReplies(tx)) >= SUPPORT_SAVED_REPLIES_MAX) {
      throw new SavedRepliesFullError();
    }
    const row = await insertSupportSavedReply(tx, {
      title,
      body,
      updatedByUserId: operator.userId,
      now,
    });
    return SupportSavedReplySchema.parse(toSavedReply(row));
  });
}

/** Changes a saved reply's title and text (AC-X-23). */
export async function editSavedReply(
  db: Database,
  operator: Operator,
  replyId: string,
  input: SupportSavedReplyInput,
): Promise<SupportSavedReply> {
  const id = parseSavedReplyId(replyId);
  const { title, body } = SupportSavedReplyInputSchema.parse(input);
  return asOperator(db, operator, 'replies.write', id, async (tx) => {
    const row = await updateSupportSavedReply(tx, id, {
      title,
      body,
      updatedByUserId: operator.userId,
    });
    if (row === undefined) throw new SavedReplyNotFoundError();
    return SupportSavedReplySchema.parse(toSavedReply(row));
  });
}

/** Deletes a saved reply (AC-X-23). */
export async function removeSavedReply(
  db: Database,
  operator: Operator,
  replyId: string,
): Promise<void> {
  const id = parseSavedReplyId(replyId);
  await asOperator(db, operator, 'replies.write', id, async (tx) => {
    if (!(await deleteSupportSavedReply(tx, id))) throw new SavedReplyNotFoundError();
  });
}

function toSavedReply(row: SupportSavedReplyRecord): Record<keyof SupportSavedReply, unknown> {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseSavedReplyId(replyId: string): string {
  const parsed = SupportSavedReplyIdSchema.safeParse(replyId);
  if (!parsed.success) throw new SavedReplyNotFoundError();
  return parsed.data;
}

/** Finds the thread across businesses, then binds the transaction to its business. */
async function bindToThread(tx: TenantTx, id: string): Promise<OperatorThreadRecord> {
  const thread = await findOperatorThread(tx, id);
  if (thread === undefined) throw new SupportThreadNotFoundError();
  await setTransactionTenant(tx, thread.tenantId as TenantId);
  return thread;
}

/**
 * Whether opening the thread is news for the business: never seen, a message since, or an hour
 * since. The access log has every open either way.
 */
export function seenAgain(
  thread: { pepperSeenAt: Date | null; lastMessageAt: Date },
  now: Date,
): boolean {
  const seen = thread.pepperSeenAt;
  return (
    seen === null ||
    seen.getTime() < thread.lastMessageAt.getTime() ||
    now.getTime() - seen.getTime() >= SEEN_AGAIN_MS
  );
}

async function toOperatorThread(
  tx: TenantTx,
  id: string,
  tenantId: string,
): Promise<OperatorThread> {
  const thread = await findOperatorThread(tx, id);
  if (thread === undefined) throw new SupportThreadNotFoundError();
  const messages = await listSupportMessages(tx, id);
  const screenshots = await screenshotsByMessage(tx, id);
  const notes = await listSupportNotes(tx, { threadId: id });
  const names = await listOperatorBusinessNames(tx, [tenantId]);
  const context = SupportContextSchema.safeParse(thread.context);
  return OperatorThreadSchema.parse({
    id: thread.id,
    reference: thread.reference,
    kind: thread.kind,
    status: thread.status,
    business: names.get(tenantId) ?? 'A business',
    openedBy:
      thread.openedByName === null
        ? null
        : {
            name: thread.openedByName,
            role: await findSupportOpenerRole(tx, thread.openedByUserId),
          },
    context: context.success ? context.data : null,
    messages: messages.map((message) => ({
      id: message.id,
      author:
        message.authorKind === 'pepper'
          ? { kind: 'pepper' }
          : { kind: 'member', name: message.authorName },
      body: message.body,
      screenshots: screenshots.get(message.id) ?? [],
      channel: message.channel,
      createdAt: message.createdAt.toISOString(),
    })),
    notes: notes.map(toNote),
    createdAt: thread.createdAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    solvedBy: thread.solvedBy,
    rating: thread.rating,
  });
}

async function toPublicRequest(tx: TenantTx, id: string): Promise<OperatorPublicRequest> {
  const request = await findPublicSupportRequest(tx, id);
  if (request === undefined) throw new SupportThreadNotFoundError();
  const notes = await listSupportNotes(tx, { publicRequestId: id });
  return OperatorPublicRequestSchema.parse({
    id: request.id,
    reference: request.reference,
    status: request.status,
    email: request.email,
    name: request.name,
    body: request.body,
    page: request.page,
    topic: request.topic,
    notes: notes.map(toNote),
    createdAt: request.createdAt.toISOString(),
  });
}

function toNote(note: SupportNoteRecord): Record<keyof SupportNote, unknown> {
  return {
    id: note.id,
    author: note.authorName,
    body: note.body,
    createdAt: note.createdAt.toISOString(),
  };
}

function parseThreadId(threadId: string): string {
  const parsed = SupportThreadIdSchema.safeParse(threadId);
  if (!parsed.success) throw new SupportThreadNotFoundError();
  return parsed.data;
}

function parsePublicId(requestId: string): string {
  const parsed = PublicSupportRequestIdSchema.safeParse(requestId);
  if (!parsed.success) throw new SupportThreadNotFoundError();
  return parsed.data;
}
