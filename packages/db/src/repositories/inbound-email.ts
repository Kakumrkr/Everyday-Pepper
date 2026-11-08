import { and, asc, eq, gt, inArray, isNotNull, lt, or, sql, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { inboundEmails } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Emails that reached the inbound webhook (S59.3, ADR-0063). Every function here runs in a
// transaction that named the inbound context (`withInboundMail`, `setTransactionInboundMail`):
// the table's only policy. No email text is stored but a held reply's, 7 days at most.

const Id = z.uuid();
const ProviderId = z.string().min(1).max(200);
const MessageId = z.string().min(3).max(300);
const Reason = z.string().regex(/^[a-z_]{1,40}$/);
const Reference = z.string().regex(/^PEP-[0-9A-HJKMNP-TV-Z]{6}$/);

export const INBOUND_STATUSES = [
  'received',
  'landed',
  'held',
  'ignored',
  'refused',
  'failed',
] as const;
export type InboundStatus = (typeof INBOUND_STATUSES)[number];

/** An email the inbound job took: what it needs to fetch it. */
export interface ClaimedInboundEmail {
  id: string;
  provider: 'resend';
  providerEmailId: string;
  messageId: string | null;
  attempts: number;
  receivedAt: Date;
  /** The operator who accepted it from the held review (S59.3.2): their word stands for the check. */
  acceptedBy: string | null;
}

/**
 * Stores an email the webhook received; `undefined` when the same event, the same provider email
 * or the same `Message-ID` is already stored (nothing changes then).
 */
export async function insertInboundEmail(
  tx: TenantTx,
  input: {
    provider: 'resend';
    eventId: string;
    providerEmailId: string;
    messageId: string | null;
    receivedAt: Date;
  },
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .insert(inboundEmails)
    .values({
      provider: input.provider,
      eventId: ProviderId.parse(input.eventId),
      providerEmailId: ProviderId.parse(input.providerEmailId),
      messageId: input.messageId === null ? null : MessageId.parse(input.messageId),
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: inboundEmails.id });
  return row;
}

/**
 * Takes up to `limit` received emails, oldest first, for `leaseMs`: each one's attempt is
 * counted now, and another worker skips it until the lease ends (a crashed pass's emails come
 * back then). Emails past `maxAttempts` aren't taken (`failInboundEmailsPastAttempts`).
 */
export async function claimInboundEmails(
  tx: TenantTx,
  input: { now: Date; leaseMs: number; limit: number; maxAttempts: number },
): Promise<ClaimedInboundEmail[]> {
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const due = tx
    .select({ id: inboundEmails.id })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.status, 'received'),
        lt(inboundEmails.attempts, input.maxAttempts),
        or(isNull(inboundEmails.leaseUntil), lt(inboundEmails.leaseUntil, input.now)),
      ),
    )
    .orderBy(asc(inboundEmails.receivedAt), asc(inboundEmails.id))
    .limit(Math.min(Math.max(input.limit, 1), 100))
    .for('update', { skipLocked: true });
  const rows = await tx
    .update(inboundEmails)
    .set({ attempts: sql`${inboundEmails.attempts} + 1`, leaseUntil })
    .where(inArray(inboundEmails.id, due))
    .returning({
      id: inboundEmails.id,
      providerEmailId: inboundEmails.providerEmailId,
      messageId: inboundEmails.messageId,
      attempts: inboundEmails.attempts,
      receivedAt: inboundEmails.receivedAt,
      acceptedBy: inboundEmails.acceptedBy,
    });
  return rows
    .map((row) => ({ ...row, provider: 'resend' as const }))
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
}

/** Locks one taken email for its outcome; `undefined` once it isn't `received` any more. */
export async function lockReceivedInboundEmail(
  tx: TenantTx,
  id: string,
): Promise<{ id: string; attempts: number } | undefined> {
  const [row] = await tx
    .select({ id: inboundEmails.id, attempts: inboundEmails.attempts })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.id, Id.parse(id)), eq(inboundEmails.status, 'received')))
    .for('update')
    .limit(1);
  return row;
}

/** What became of a taken email (S59.3, S59.3.2). Only a held one keeps its sender and text. */
export type InboundOutcome =
  | {
      status: 'landed';
      tenantId: string;
      threadId: string;
      supportMessageId: string;
      reason?: string;
    }
  | { status: 'landed'; tenantId: string; threadId: string; supportNoteId: string; reason: string }
  | { status: 'landed'; publicRequestId: string; reason: string }
  | {
      status: 'held';
      reason: string;
      /** A stranger's new request has neither; a member's new request has no thread. */
      tenantId: string | null;
      threadId: string | null;
      fromAddress: string;
      heldText: string;
      heldSubject?: string | null;
    }
  | {
      status: 'ignored' | 'refused' | 'failed';
      reason: string;
      tenantId?: string | null;
      threadId?: string | null;
    };

const SenderHash = z.string().regex(/^[0-9a-f]{64}$/);

/** Records what became of a taken email; `senderHash` names its sender for the loop guard. */
export async function finishInboundEmail(
  tx: TenantTx,
  id: string,
  outcome: InboundOutcome,
  now: Date,
  senderHash?: string | null,
): Promise<void> {
  const held = outcome.status === 'held';
  const optionalId = (
    key: 'tenantId' | 'threadId' | 'supportMessageId' | 'supportNoteId' | 'publicRequestId',
  ): string | null => {
    const value = (outcome as Partial<Record<typeof key, string | null>>)[key];
    return typeof value === 'string' ? Id.parse(value) : null;
  };
  await tx
    .update(inboundEmails)
    .set({
      status: outcome.status,
      reason: outcome.reason === undefined ? null : Reason.parse(outcome.reason),
      tenantId: optionalId('tenantId'),
      threadId: optionalId('threadId'),
      supportMessageId: optionalId('supportMessageId'),
      supportNoteId: optionalId('supportNoteId'),
      publicRequestId: optionalId('publicRequestId'),
      fromAddress: held ? outcome.fromAddress.slice(0, 254) : null,
      heldText: held ? outcome.heldText.slice(0, 4000) : null,
      heldSubject: held && outcome.heldSubject ? outcome.heldSubject.slice(0, 200) : null,
      senderHash:
        senderHash === undefined || senderHash === null ? null : SenderHash.parse(senderHash),
      leaseUntil: null,
      processedAt: now,
    })
    .where(eq(inboundEmails.id, Id.parse(id)));
}

/** Gives up on received emails that used every attempt; returns how many. */
export async function failInboundEmailsPastAttempts(
  tx: TenantTx,
  input: { now: Date; maxAttempts: number },
): Promise<number> {
  const rows = await tx
    .update(inboundEmails)
    .set({ status: 'failed', reason: 'gave_up', leaseUntil: null, processedAt: input.now })
    .where(
      and(
        eq(inboundEmails.status, 'received'),
        sql`${inboundEmails.attempts} >= ${input.maxAttempts}`,
        or(isNull(inboundEmails.leaseUntil), lt(inboundEmails.leaseUntil, input.now)),
      ),
    )
    .returning({ id: inboundEmails.id });
  return rows.length;
}

/** Replies that landed in a thread since `since` (the loop guard: 5 an hour). */
export async function countInboundLanded(
  tx: TenantTx,
  input: { tenantId: string; threadId: string; since: Date },
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.tenantId, Id.parse(input.tenantId)),
        eq(inboundEmails.threadId, Id.parse(input.threadId)),
        eq(inboundEmails.status, 'landed'),
        gt(inboundEmails.processedAt, input.since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Emails to the team's address from one sender since `since` that were taken further than the
 * first checks (the loop guard for new requests: 5 an hour, S59.3.2).
 */
export async function countInboundFromSender(
  tx: TenantTx,
  input: { senderHash: string; since: Date },
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(inboundEmails)
    .where(
      and(
        eq(inboundEmails.senderHash, SenderHash.parse(input.senderHash)),
        inArray(inboundEmails.status, ['landed', 'held']),
        gt(inboundEmails.processedAt, input.since),
      ),
    );
  return row?.count ?? 0;
}

/** Empties held emails older than `before` (sender and text); returns how many. */
export async function emptyHeldInboundEmails(tx: TenantTx, before: Date): Promise<number> {
  const rows = await tx
    .update(inboundEmails)
    .set({ fromAddress: null, heldText: null })
    .where(
      and(
        eq(inboundEmails.status, 'held'),
        lt(inboundEmails.processedAt, before),
        or(isNotNull(inboundEmails.fromAddress), isNotNull(inboundEmails.heldText)),
      ),
    )
    .returning({ id: inboundEmails.id });
  return rows.length;
}

/** One stored email (tests and the console's later review). */
export async function findInboundEmail(
  tx: TenantTx,
  id: string,
): Promise<typeof inboundEmails.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(inboundEmails)
    .where(eq(inboundEmails.id, Id.parse(id)))
    .limit(1);
  return row;
}

/**
 * The business and thread of request `reference` (`support_inbound_thread`), for an emailed
 * reply whose signature already checked; `undefined` for no such request.
 */
export async function findSupportThreadForInbound(
  db: Database | TenantTx,
  reference: string,
): Promise<{ tenantId: string; threadId: string } | undefined> {
  const ref = Reference.parse(reference);
  const { rows } = await db.execute<{ tenant_id: string; thread_id: string }>(
    sql`SELECT tenant_id, thread_id FROM support_inbound_thread(${ref})`,
  );
  const row = rows[0];
  return row === undefined ? undefined : { tenantId: row.tenant_id, threadId: row.thread_id };
}

// The console's held review and counts (S59.3.2, AC-X-44/45). These run in `withOperator`,
// whose `operator_access`/`operator_review` policies show inbound rows and let a held one move.

/** A held email in the console: who sent it, why it waits, its text. */
export interface HeldInboundRow {
  id: string;
  reason: string;
  tenantId: string | null;
  threadId: string | null;
  fromAddress: string;
  subject: string | null;
  text: string;
  receivedAt: Date;
  heldAt: Date;
}

/** Held emails that still have their contents, longest waiting first. */
export async function listHeldInboundEmails(
  tx: TenantTx,
  input: { limit: number },
): Promise<HeldInboundRow[]> {
  const rows = await tx
    .select({
      id: inboundEmails.id,
      reason: inboundEmails.reason,
      tenantId: inboundEmails.tenantId,
      threadId: inboundEmails.threadId,
      fromAddress: inboundEmails.fromAddress,
      subject: inboundEmails.heldSubject,
      text: inboundEmails.heldText,
      receivedAt: inboundEmails.receivedAt,
      heldAt: inboundEmails.processedAt,
    })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.status, 'held'), isNotNull(inboundEmails.fromAddress)))
    .orderBy(asc(inboundEmails.processedAt), asc(inboundEmails.id))
    .limit(Math.min(Math.max(input.limit, 1), 200));
  return rows.map((row) => ({
    id: row.id,
    reason: row.reason ?? 'held',
    tenantId: row.tenantId,
    threadId: row.threadId,
    fromAddress: row.fromAddress ?? '',
    subject: row.subject,
    text: row.text ?? '',
    receivedAt: row.receivedAt,
    heldAt: row.heldAt ?? row.receivedAt,
  }));
}

/** How many held emails still wait for a look (the inbox header, AC-X-46). */
export async function countHeldInboundEmails(tx: TenantTx): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(inboundEmails)
    .where(and(eq(inboundEmails.status, 'held'), isNotNull(inboundEmails.fromAddress)));
  return row?.count ?? 0;
}

/**
 * Accept (AC-X-44): the held email goes back to the inbound job with the operator's word for its
 * sender; it is fetched again and lands as if its check had passed. `false` when it is no longer
 * held with its contents (already reviewed, or emptied after 7 days).
 */
export async function acceptHeldInboundEmail(
  tx: TenantTx,
  input: { id: string; operatorUserId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(inboundEmails)
    .set({
      status: 'received',
      reason: null,
      attempts: 0,
      leaseUntil: null,
      processedAt: null,
      fromAddress: null,
      heldText: null,
      heldSubject: null,
      acceptedBy: Id.parse(input.operatorUserId),
      acceptedAt: input.now,
    })
    .where(
      and(
        eq(inboundEmails.id, Id.parse(input.id)),
        eq(inboundEmails.status, 'held'),
        isNotNull(inboundEmails.fromAddress),
      ),
    )
    .returning({ id: inboundEmails.id });
  return rows.length === 1;
}

/** Discard (AC-X-44): the held email is emptied and counted as discarded. */
export async function discardHeldInboundEmail(
  tx: TenantTx,
  input: { id: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(inboundEmails)
    .set({
      status: 'ignored',
      reason: 'discarded',
      fromAddress: null,
      heldText: null,
      heldSubject: null,
      processedAt: input.now,
    })
    .where(
      and(
        eq(inboundEmails.id, Id.parse(input.id)),
        eq(inboundEmails.status, 'held'),
        isNotNull(inboundEmails.fromAddress),
      ),
    )
    .returning({ id: inboundEmails.id });
  return rows.length === 1;
}

/** Inbound emails received since `since`, by status and reason (AC-X-45). */
export async function countInboundByOutcome(
  tx: TenantTx,
  since: Date,
): Promise<{ status: InboundStatus; reason: string | null; count: number }[]> {
  const rows = await tx
    .select({
      status: inboundEmails.status,
      reason: inboundEmails.reason,
      count: sql<number>`count(*)::int`,
    })
    .from(inboundEmails)
    .where(gt(inboundEmails.receivedAt, since))
    .groupBy(inboundEmails.status, inboundEmails.reason)
    .orderBy(asc(inboundEmails.status), asc(inboundEmails.reason));
  return rows.map((row) => ({
    status: z.enum(INBOUND_STATUSES).parse(row.status),
    reason: row.reason,
    count: row.count,
  }));
}

/**
 * The member an email to the team's address came from (`support_inbound_member`, S59.3.2): the
 * user, the business it goes to and how many businesses they belong to; `undefined` for no
 * verified account with that address. Call only once the receiver's check passed or an
 * operator accepted the email.
 */
export async function findSupportMemberForInbound(
  db: Database | TenantTx,
  email: string,
): Promise<{ userId: string; tenantId: string; businesses: number } | undefined> {
  const address = z.string().min(3).max(254).parse(email);
  const { rows } = await db.execute<{ user_id: string; tenant_id: string; businesses: number }>(
    sql`SELECT user_id, tenant_id, businesses FROM support_inbound_member(${address})`,
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { userId: row.user_id, tenantId: row.tenant_id, businesses: row.businesses };
}
