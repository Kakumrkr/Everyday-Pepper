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
  type SupportStatus,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  findOperatorThread,
  findPublicSupportRequest,
  findSupportOpenerRole,
  insertSupportNote,
  isPlatformOperator,
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
  type OperatorInboxRow,
  type SupportNoteRecord,
  type TenantTx,
} from '@pepper/db';
import { systemClock, type Clock } from '../clock.js';
import { SupportThreadNotFoundError } from '../errors.js';
import { answerInThread, type SupportOptions } from './support.js';

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
 * The inbox (AC-X-20): the view's business threads and public requests together, the one that
 * has waited longest first; `waiting` counts what waits on Pepper whatever the view.
 */
export async function readOperatorInbox(
  db: Database,
  operator: Operator,
  query: OperatorInboxQuery,
): Promise<OperatorInbox> {
  const { view } = OperatorInboxQuerySchema.parse(query);
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'inbox.read', targetId: null },
    async (tx) => {
      const rows = sortOldestFirst([
        ...(await listOperatorThreads(tx, { statuses: THREAD_STATUSES[view], limit: INBOX_LIMIT })),
        ...(await listOperatorPublicRequests(tx, {
          statuses: PUBLIC_STATUSES[view],
          limit: INBOX_LIMIT,
        })),
      ]).slice(0, INBOX_LIMIT);
      const names = await listOperatorBusinessNames(
        tx,
        rows.flatMap((row) => (row.tenantId === null ? [] : [row.tenantId])),
      );
      const waiting =
        view === 'waiting'
          ? rows.length
          : (await listOperatorThreads(tx, { statuses: ['waiting_on_pepper'], limit: 500 }))
              .length +
            (await listOperatorPublicRequests(tx, { statuses: ['open'], limit: 500 })).length;
      return OperatorInboxSchema.parse({
        view,
        items: rows.map((row) => toInboxItem(row, names)),
        waiting,
      });
    },
  );
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
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'thread.read', targetId: id },
    async (tx) => {
      const tenantId = await bindToThread(tx, id);
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
      return toOperatorThread(tx, id, tenantId);
    },
  );
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
  const { message } = SupportReplyInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'thread.reply', targetId: id },
    async (tx) => {
      const tenantId = await bindToThread(tx, id);
      await answerInThread(tx, id, message, { kind: 'operator' }, options, now);
      await markSupportThreadSeenByPepper(tx, id, now);
      return toOperatorThread(tx, id, tenantId);
    },
  );
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
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'thread.status', targetId: id },
    async (tx) => {
      const tenantId = await bindToThread(tx, id);
      const thread = await lockSupportThread(tx, id);
      if (thread === undefined) throw new SupportThreadNotFoundError();
      if (thread.status !== status) {
        await setSupportThreadStatus(tx, id, status, now);
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
    },
  );
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
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'thread.note', targetId: id },
    async (tx) => {
      const tenantId = await bindToThread(tx, id);
      await insertSupportNote(tx, {
        threadId: id,
        authorUserId: operator.userId,
        body: note,
        now,
      });
      return toOperatorThread(tx, id, tenantId);
    },
  );
}

/** A public request (AC-X-21). */
export async function readPublicRequest(
  db: Database,
  operator: Operator,
  requestId: string,
): Promise<OperatorPublicRequest> {
  const id = parsePublicId(requestId);
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'public.read', targetId: id },
    (tx) => toPublicRequest(tx, id),
  );
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
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'public.status', targetId: id },
    async (tx) => {
      const request = await findPublicSupportRequest(tx, id, { lock: true });
      if (request === undefined) throw new SupportThreadNotFoundError();
      if (request.status !== status) await setPublicSupportRequestStatus(tx, id, status, now);
      return toPublicRequest(tx, id);
    },
  );
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
  return withOperator(
    db,
    { operatorUserId: operator.userId, action: 'public.note', targetId: id },
    async (tx) => {
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
    },
  );
}

/** Finds the thread across businesses, then binds the transaction to its business. */
async function bindToThread(tx: TenantTx, id: string): Promise<TenantId> {
  const thread = await findOperatorThread(tx, id);
  if (thread === undefined) throw new SupportThreadNotFoundError();
  const tenantId = thread.tenantId as TenantId;
  await setTransactionTenant(tx, tenantId);
  return tenantId;
}

async function toOperatorThread(
  tx: TenantTx,
  id: string,
  tenantId: TenantId,
): Promise<OperatorThread> {
  const thread = await findOperatorThread(tx, id);
  if (thread === undefined) throw new SupportThreadNotFoundError();
  const messages = await listSupportMessages(tx, id);
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
      createdAt: message.createdAt.toISOString(),
    })),
    notes: notes.map(toNote),
    createdAt: thread.createdAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
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
