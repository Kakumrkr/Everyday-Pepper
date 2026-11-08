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

/** Records what became of a taken email. Only a held one keeps its sender and text. */
export async function finishInboundEmail(
  tx: TenantTx,
  id: string,
  outcome:
    | {
        status: 'landed';
        tenantId: string;
        threadId: string;
        supportMessageId: string;
        reason?: string;
      }
    | {
        status: 'held';
        reason: string;
        tenantId: string;
        threadId: string;
        fromAddress: string;
        heldText: string;
      }
    | {
        status: 'ignored' | 'refused' | 'failed';
        reason: string;
        tenantId?: string | null;
        threadId?: string | null;
      },
  now: Date,
): Promise<void> {
  const held = outcome.status === 'held';
  await tx
    .update(inboundEmails)
    .set({
      status: outcome.status,
      reason: outcome.reason === undefined ? null : Reason.parse(outcome.reason),
      tenantId:
        'tenantId' in outcome && outcome.tenantId != null ? Id.parse(outcome.tenantId) : null,
      threadId:
        'threadId' in outcome && outcome.threadId != null ? Id.parse(outcome.threadId) : null,
      supportMessageId: outcome.status === 'landed' ? Id.parse(outcome.supportMessageId) : null,
      fromAddress: held ? outcome.fromAddress.slice(0, 254) : null,
      heldText: held ? outcome.heldText.slice(0, 4000) : null,
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
