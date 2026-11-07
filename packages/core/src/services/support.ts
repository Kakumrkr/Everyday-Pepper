import { randomInt } from 'node:crypto';
import {
  PublicSupportInputSchema,
  SUPPORT_MESSAGES_PER_DAY,
  SUPPORT_THREADS_PER_DAY,
  SupportContextSchema,
  SupportReplyInputSchema,
  SupportThreadIdSchema,
  SupportThreadInputSchema,
  SupportThreadSchema,
  UtcDateTimeSchema,
  type PublicSupportInput,
  type SupportAuthor,
  type SupportContext,
  type SupportCreated,
  type SupportKind,
  type SupportReplyInput,
  type SupportThread,
  type SupportThreadInput,
  type SupportThreadList,
  type SupportThreadSummary,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  appendSupportMessage,
  countSupportWrites,
  countUnreadSupportThreads,
  findCurrentTenant,
  findMembership,
  findSupportThread,
  findSupportThreadSeenAt,
  hasActivation,
  insertPublicSupportRequest,
  insertSupportThread,
  isBusinessBookable,
  listSupportMessages,
  listSupportThreads as listSupportThreadRows,
  listTenantMembers,
  lockSupportThread,
  lockSupportWriter,
  markSupportThreadRead,
  setSupportThreadStatus,
  withMember,
  withTenant,
  type Database,
  type SupportMessageRecord,
  type SupportThreadRecord,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import { SupportLimitReachedError, SupportThreadNotFoundError } from '../errors.js';
import type { Mailer } from '../outbox.js';
import { queueEmail } from './outbox.js';

// Pepper's own support (S59, PCR-010, AC-X-14…18). Every member may ask for help: there is no
// permission to check, only who may read which thread, which the tables' RLS decides (the
// opener, and the business's owners and managers). A request reaches the team's address
// through the outbox, `Reply-To` the requester, so the team answers from their inbox until
// S59.3 brings those answers back into the thread; the team's answers in the app come from
// `answerSupportThread` (S59.2's console). Message text is never logged or audited.

export interface SupportOptions {
  /** Seals queued emails (ADR-0024). */
  outboxKey: Buffer;
  /** The team's address (`SUPPORT_EMAIL`); `null`: requests are kept, nothing is emailed. */
  supportEmail: string | null;
  /** The app's public origin, for links in emails. */
  baseUrl: string;
  /** The api's release, recorded with each request. */
  release: string;
  clock?: Clock;
}

/** What the server knows about the request it was sent with. */
export interface SupportRequestMeta {
  userAgent: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const THREAD_LIST_LIMIT = 100;
const REFERENCE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const REFERENCE_TRIES = 5;

/** A new reference: "PEP-" and 6 random characters of Crockford's base 32. */
export function newSupportReference(): string {
  let code = '';
  for (let i = 0; i < 6; i += 1)
    code += REFERENCE_ALPHABET.charAt(randomInt(REFERENCE_ALPHABET.length));
  return `PEP-${code}`;
}

/** The words people see for a kind, in emails and in the app. */
export const SUPPORT_KIND_LABELS: Readonly<Record<SupportKind, string>> = {
  problem: 'Something’s not working',
  question: 'A question',
  idea: 'An idea',
};

/**
 * Opens a request (AC-X-14): the member's message with the context their browser sent and what
 * the server adds (the release, the browser, their role, the business's setup state). Five a
 * day per person. The team's address gets one email, `Reply-To` the member.
 */
export async function openSupportThread(
  db: Database,
  actor: Actor,
  input: SupportThreadInput,
  meta: SupportRequestMeta,
  options: SupportOptions,
): Promise<SupportCreated> {
  const parsed = SupportThreadInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  const { userId, role } = actor.context;
  return withMember(db, actor.context, async (tx) => {
    await checkLimits(tx, userId, now, 'thread');
    const context: SupportContext = SupportContextSchema.parse({
      ...parsed.context,
      appVersion: options.release,
      userAgent: meta.userAgent === null ? null : meta.userAgent.slice(0, 300),
      role,
      setup: {
        bookable: await isBusinessBookable(tx),
        firstBooking: await hasActivation(tx, 'first_booking'),
      },
    });
    let created: { id: string; reference: string } | null = null;
    for (let attempt = 0; attempt < REFERENCE_TRIES && created === null; attempt += 1) {
      const reference = newSupportReference();
      const row = await insertSupportThread(tx, {
        reference,
        kind: parsed.kind,
        openedByUserId: userId,
        context,
        body: parsed.message,
        now,
      });
      if (row !== null) created = { id: row.id, reference };
    }
    if (created === null) throw new Error('No free support reference');
    // The opener has seen everything in it so far.
    await markSupportThreadRead(tx, created.id, userId, now);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'support_thread.opened',
        entity: { type: 'support_thread', id: created.id },
        before: null,
        after: { kind: parsed.kind, status: 'waiting_on_pepper' },
      },
      requestId: actor.requestId,
    });
    const requester = await requesterOf(tx, userId);
    await emailTeam(tx, options, {
      threadId: created.id,
      reference: created.reference,
      kind: parsed.kind,
      message: parsed.message,
      requester,
      context,
      dedupeKey: `support.opened:${created.id}`,
      now,
      first: true,
    });
    return {
      id: SupportThreadIdSchema.parse(created.id),
      reference: created.reference,
      replyTo: requester.email,
    };
  });
}

/** "Your requests" (AC-X-15): the threads the member may read, newest activity first. */
export async function listSupportThreads(db: Database, actor: Actor): Promise<SupportThreadList> {
  const { userId } = actor.context;
  return withMember(db, actor.context, async (tx) => {
    const rows = await listSupportThreadRows(tx, { reader: userId, limit: THREAD_LIST_LIMIT });
    return {
      threads: rows.map((row) => toSummary(row, userId)),
      unread: await countUnreadSupportThreads(tx, userId),
    };
  });
}

/** More's count (AC-X-16): the member's own threads with an unread answer. */
export async function countSupportUnread(db: Database, actor: Actor): Promise<number> {
  return withMember(db, actor.context, (tx) => countUnreadSupportThreads(tx, actor.context.userId));
}

/** A thread with its messages; opening it marks the team's answers read for the member. */
export async function readSupportThread(
  db: Database,
  actor: Actor,
  threadId: string,
  options: { clock?: Clock } = {},
): Promise<SupportThread> {
  const id = parseThreadId(threadId);
  const now = (options.clock ?? systemClock).now();
  const { userId } = actor.context;
  return withMember(db, actor.context, async (tx) => {
    const row = await findSupportThread(tx, id, userId);
    if (row === undefined) throw new SupportThreadNotFoundError();
    await markSupportThreadRead(tx, id, userId, now);
    return toThread(tx, { ...row, unread: false }, userId);
  });
}

/**
 * A member's reply (AC-X-15): back to "Waiting on Pepper" (a solved request reopens), and the
 * team's address hears of it under the same reference.
 */
export async function replyToSupportThread(
  db: Database,
  actor: Actor,
  threadId: string,
  input: SupportReplyInput,
  options: SupportOptions,
): Promise<SupportThread> {
  const id = parseThreadId(threadId);
  const { message } = SupportReplyInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  const { userId } = actor.context;
  return withMember(db, actor.context, async (tx) => {
    const thread = await lockSupportThread(tx, id);
    if (thread === undefined) throw new SupportThreadNotFoundError();
    await checkLimits(tx, userId, now, 'message');
    const written = await appendSupportMessage(tx, {
      threadId: id,
      author: { kind: 'member', userId },
      body: message,
      status: 'waiting_on_pepper',
      now,
    });
    await markSupportThreadRead(tx, id, userId, now);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'support_thread.replied',
        entity: { type: 'support_thread', id },
        before: { status: thread.status },
        after: { status: 'waiting_on_pepper' },
      },
      requestId: actor.requestId,
    });
    const row = await findSupportThread(tx, id, userId);
    if (row === undefined) throw new SupportThreadNotFoundError();
    await emailTeam(tx, options, {
      threadId: id,
      reference: thread.reference,
      kind: row.kind,
      message,
      requester: await requesterOf(tx, userId),
      context: null,
      dedupeKey: `support.replied:${written.id}`,
      now,
      first: false,
    });
    return toThread(tx, row, userId);
  });
}

/** Marks a request solved (AC-X-15); solving a solved one changes nothing. */
export async function solveSupportThread(
  db: Database,
  actor: Actor,
  threadId: string,
  options: { clock?: Clock } = {},
): Promise<SupportThread> {
  const id = parseThreadId(threadId);
  const now = (options.clock ?? systemClock).now();
  const { userId } = actor.context;
  return withMember(db, actor.context, async (tx) => {
    const thread = await lockSupportThread(tx, id);
    if (thread === undefined) throw new SupportThreadNotFoundError();
    if (thread.status !== 'solved') {
      await setSupportThreadStatus(tx, id, 'solved', now);
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'support_thread.solved',
          entity: { type: 'support_thread', id },
          before: { status: thread.status },
          after: { status: 'solved' },
        },
        requestId: actor.requestId,
      });
    }
    const row = await findSupportThread(tx, id, userId);
    if (row === undefined) throw new SupportThreadNotFoundError();
    return toThread(tx, row, userId);
  });
}

/**
 * The Pepper team's answer (AC-X-16), from S59.2's console: a message of the team's, the
 * status "Pepper replied", and one email to the requester (while they are still a member)
 * with the answer and a link to the thread, `Reply-To` the team. Runs without a user.
 */
export async function answerSupportThread(
  db: Database,
  tenantId: TenantId,
  threadId: string,
  input: SupportReplyInput,
  options: SupportOptions,
): Promise<{ messageId: string }> {
  const id = parseThreadId(threadId);
  const { message } = SupportReplyInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  return withTenant(db, tenantId, (tx) =>
    answerInThread(tx, id, message, { kind: 'system' }, options, now),
  );
}

/**
 * The team's answer inside a transaction bound to the thread's business: by the console
 * (`operator`, S59.2) or a job (`system`).
 */
export async function answerInThread(
  tx: TenantTx,
  id: string,
  message: string,
  actor: { kind: 'system' } | { kind: 'operator' },
  options: SupportOptions,
  now: Date,
): Promise<{ messageId: string }> {
  const thread = await lockSupportThread(tx, id);
  if (thread === undefined) throw new SupportThreadNotFoundError();
  const written = await appendSupportMessage(tx, {
    threadId: id,
    author: { kind: 'pepper' },
    body: message,
    status: 'pepper_replied',
    now,
  });
  await appendAuditEntry(tx, {
    actor,
    change: {
      action: 'support_thread.replied',
      entity: { type: 'support_thread', id },
      before: { status: thread.status },
      after: { status: 'pepper_replied' },
    },
  });
  const row = await findSupportThread(tx, id, null);
  const openerId = row?.openedByUserId ?? null;
  const opener =
    openerId === null
      ? undefined
      : (await listTenantMembers(tx)).find((member) => member.userId === openerId);
  if (opener !== undefined) {
    const firstName = opener.name.trim().split(/\s+/)[0] ?? '';
    const link = `${options.baseUrl}/support/${id}`;
    await queueEmail(
      tx,
      {
        to: opener.email,
        subject: `Pepper replied to ${thread.reference}`,
        text: [
          firstName === '' ? 'Hi,' : `Hi ${firstName},`,
          '',
          `The Pepper team answered your request ${thread.reference}:`,
          '',
          message,
          '',
          `Read it and reply in the app: ${link}`,
          '',
          '— The Pepper team',
        ].join('\n'),
        ...(options.supportEmail !== null && { replyTo: options.supportEmail }),
      },
      { key: options.outboxKey, dedupeKey: `support.answered:${written.id}`, now },
    );
  }
  return { messageId: written.id };
}

/**
 * The public form (AC-X-17), for people who can't sign in: kept, and sent to the team's
 * address at once, `Reply-To` the address they typed. Nothing is ever sent to that address.
 * A filled honeypot is accepted and dropped. `sent: false`: no mailer or no team address, or
 * the mail server refused; the request is kept either way.
 */
export async function submitPublicSupportRequest(
  db: Database,
  mailer: Mailer | null,
  input: PublicSupportInput,
  options: Pick<SupportOptions, 'supportEmail' | 'release' | 'clock'> & {
    userAgent: string | null;
  },
): Promise<SupportCreated & { sent: boolean }> {
  const parsed = PublicSupportInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  if (parsed.website !== undefined && parsed.website.trim() !== '') {
    return { id: null, reference: newSupportReference(), replyTo: parsed.email, sent: false };
  }
  const name = parsed.name === undefined || parsed.name === '' ? null : parsed.name;
  let reference: string | null = null;
  for (let attempt = 0; attempt < REFERENCE_TRIES && reference === null; attempt += 1) {
    const candidate = newSupportReference();
    const row = await insertPublicSupportRequest(db, {
      reference: candidate,
      email: parsed.email,
      name,
      body: parsed.message,
      page: parsed.page ?? null,
      topic: parsed.topic ?? null,
      now,
    });
    if (row !== null) reference = candidate;
  }
  if (reference === null) throw new Error('No free support reference');
  let sent = false;
  if (mailer !== null && options.supportEmail !== null) {
    try {
      await mailer.send({
        to: options.supportEmail,
        replyTo: parsed.email,
        subject: `[${reference}] Signed-out request`,
        text: [
          `${reference} · from the public form (not signed in)`,
          `From: ${name === null ? '' : `${name} `}<${parsed.email}> — reply to this email to answer them.`,
          '',
          parsed.message,
          '',
          '---',
          `Page: ${parsed.page ?? '—'}`,
          `Help article: ${parsed.topic ?? '—'}`,
          `App version: ${options.release}`,
          `Browser: ${options.userAgent?.slice(0, 300) ?? '—'}`,
        ].join('\n'),
      });
      sent = true;
    } catch {
      // Kept for the console (S59.2); the person still gets their reference.
      sent = false;
    }
  }
  return { id: null, reference, replyTo: parsed.email, sent };
}

function parseThreadId(threadId: string): string {
  const parsed = SupportThreadIdSchema.safeParse(threadId);
  if (!parsed.success) throw new SupportThreadNotFoundError();
  return parsed.data;
}

async function checkLimits(
  tx: TenantTx,
  userId: UserId,
  now: Date,
  writing: 'thread' | 'message',
): Promise<void> {
  await lockSupportWriter(tx, userId);
  const counts = await countSupportWrites(tx, userId, new Date(now.getTime() - DAY_MS));
  if (writing === 'thread' && counts.threads >= SUPPORT_THREADS_PER_DAY) {
    throw new SupportLimitReachedError('threads');
  }
  if (counts.messages >= SUPPORT_MESSAGES_PER_DAY) throw new SupportLimitReachedError('messages');
}

interface Requester {
  name: string;
  email: string;
  businessName: string;
  role: string;
}

async function requesterOf(tx: TenantTx, userId: UserId): Promise<Requester> {
  const tenant = await findCurrentTenant(tx);
  const membership = await findMembership(tx, userId);
  const member = (await listTenantMembers(tx)).find((row) => row.userId === userId);
  if (tenant === undefined || membership === undefined || member === undefined) {
    throw new SupportThreadNotFoundError();
  }
  return {
    name: member.name,
    email: member.email,
    businessName: tenant.name,
    role: membership.role,
  };
}

/** The team's email about a request or a member's reply to it. */
async function emailTeam(
  tx: TenantTx,
  options: SupportOptions,
  mail: {
    threadId: string;
    reference: string;
    kind: SupportKind;
    message: string;
    requester: Requester;
    context: SupportContext | null;
    dedupeKey: string;
    now: Date;
    first: boolean;
  },
): Promise<void> {
  if (options.supportEmail === null) return;
  const { requester, context } = mail;
  const label = SUPPORT_KIND_LABELS[mail.kind];
  const subject = `${mail.first ? '' : 'Re: '}[${mail.reference}] ${label} — ${requester.businessName}`;
  const details =
    context === null
      ? []
      : [
          '---',
          `Page: ${context.page ?? '—'}`,
          `Help article: ${context.topic ?? '—'}`,
          `Error reference: ${context.errorRef ?? '—'}`,
          `App version: ${context.appVersion}`,
          `Browser: ${context.userAgent ?? '—'}`,
          `Screen: ${context.viewport === undefined ? '—' : `${String(context.viewport.width)}×${String(context.viewport.height)}`}`,
          `Setup: ${context.setup.bookable ? 'bookable' : 'not bookable yet'}, ${context.setup.firstBooking ? 'has a first booking' : 'no booking yet'}`,
        ];
  await queueEmail(
    tx,
    {
      to: options.supportEmail,
      replyTo: requester.email,
      subject,
      text: [
        `${mail.reference} · ${label}${mail.first ? '' : ' · a new reply'}`,
        `From: ${requester.name} <${requester.email}>, ${requester.role} at ${requester.businessName} — reply to this email to answer them.`,
        '',
        mail.message,
        '',
        ...details,
        `Thread: ${mail.threadId}`,
      ].join('\n'),
    },
    { key: options.outboxKey, dedupeKey: mail.dedupeKey, now: mail.now },
  );
}

function authorOf(
  kind: 'member' | 'pepper',
  userId: string | null,
  name: string | null,
  reader: UserId,
): SupportAuthor {
  if (kind === 'pepper') return { kind: 'pepper' };
  if (userId === null || name === null) return { kind: 'former_member' };
  if (userId === reader) return { kind: 'you' };
  return { kind: 'teammate', name };
}

function toSummary(row: SupportThreadRecord, reader: UserId): SupportThreadSummary {
  return {
    id: SupportThreadIdSchema.parse(row.id),
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    preview: row.preview,
    openedBy: authorOf('member', row.openedByUserId, row.openedByName, reader),
    unread: row.unread,
    createdAt: UtcDateTimeSchema.parse(row.createdAt.toISOString()),
    lastMessageAt: UtcDateTimeSchema.parse(row.lastMessageAt.toISOString()),
  };
}

async function toThread(
  tx: TenantTx,
  row: SupportThreadRecord,
  reader: UserId,
): Promise<SupportThread> {
  const messages: SupportMessageRecord[] = await listSupportMessages(tx, row.id);
  const requester =
    row.openedByUserId === reader ? await requesterOf(tx, reader).catch(() => null) : null;
  return SupportThreadSchema.parse({
    ...toSummary(row, reader),
    messages: messages.map((message) => ({
      id: message.id,
      author: authorOf(message.authorKind, message.authorUserId, message.authorName, reader),
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
    replyTo: requester?.email ?? null,
    seenByPepperAt: (await findSupportThreadSeenAt(tx, row.id))?.toISOString() ?? null,
  });
}
