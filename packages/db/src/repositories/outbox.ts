import {
  OutboxDedupeKeySchema,
  OutboxMessageIdSchema,
  OutboxMessageTypeSchema,
  TenantIdSchema,
  type OutboxDedupeKey,
  type OutboxMessageId,
  type OutboxMessageType,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { outboxDispatch, outboxMessages, type OutboxMessageRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The transactional outbox (ADR-0003, ADR-0024). Messages and their `outbox_dispatch` index
// rows are tenant-owned (RLS). The index holds only ids and due times, and the relay reads it
// across businesses (`listDueOutboxMessages`), then handles each message under its own tenant.
// Every change of a pending message's due time is mirrored to its index row in the same
// transaction.

const ErrorNameSchema = z
  .string()
  .transform((value) => value.replace(/[^A-Za-z0-9.:_-]/g, '').slice(0, 100) || 'Error');

export interface NewOutboxMessage {
  /** Chosen by the caller: the encryption binds the payload to it. */
  id: OutboxMessageId;
  type: OutboxMessageType;
  dedupeKey: OutboxDedupeKey;
  /** The content, encrypted by the caller. */
  payload: Buffer;
  availableAt: Date;
}

/**
 * Queues a message for the transaction's tenant, with its dispatch row. Returns the new row,
 * or `undefined` when the business already has a message with this dedupe key (nothing is
 * queued then).
 */
export async function insertOutboxMessage(
  tx: TenantTx,
  input: NewOutboxMessage,
): Promise<OutboxMessageRow | undefined> {
  const [row] = await tx
    .insert(outboxMessages)
    .values({
      id: OutboxMessageIdSchema.parse(input.id),
      type: OutboxMessageTypeSchema.parse(input.type),
      dedupeKey: OutboxDedupeKeySchema.parse(input.dedupeKey),
      payload: z.instanceof(Buffer).parse(input.payload),
      availableAt: input.availableAt,
    })
    .onConflictDoNothing({ target: [outboxMessages.tenantId, outboxMessages.dedupeKey] })
    .returning();
  if (row === undefined) return undefined;
  await tx
    .insert(outboxDispatch)
    .values({ id: row.id, tenantId: row.tenantId, availableAt: row.availableAt });
  return row;
}

/** A due message and its business, as the dispatch index lists it. */
export interface DueOutboxMessage {
  messageId: OutboxMessageId;
  tenantId: TenantId;
}

/**
 * Up to `limit` messages due at `now`, across businesses, the longest waiting first. Reads the
 * dispatch index only, in a read-only transaction without a tenant that the `outbox_scan`
 * policy lets see every business's index rows; the messages are read under their tenant.
 */
export async function listDueOutboxMessages(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueOutboxMessage[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const rows = await db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.outbox_scan', 'on', true)`);
      return tx
        .select({ id: outboxDispatch.id, tenantId: outboxDispatch.tenantId })
        .from(outboxDispatch)
        .where(lte(outboxDispatch.availableAt, now))
        .orderBy(asc(outboxDispatch.availableAt))
        .limit(max);
    },
    { accessMode: 'read only' },
  );
  return rows.map((row) => ({
    messageId: OutboxMessageIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

/** The transaction's tenant's message with this id. */
/**
 * How many of the business's messages, in any state, have a dedupe key starting with `prefix`
 * (evals and tests: "one rebooking email went", S36).
 */
export async function countOutboxMessagesByKey(tx: TenantTx, prefix: string): Promise<number> {
  const like = `${OutboxDedupeKeySchema.parse(prefix).replace(/[%_\\]/g, '\\$&')}%`;
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(outboxMessages)
    .where(sql`${outboxMessages.dedupeKey} LIKE ${like}`);
  return row?.count ?? 0;
}

export async function findOutboxMessage(
  tx: TenantTx,
  id: OutboxMessageId,
): Promise<OutboxMessageRow | undefined> {
  const [row] = await tx
    .select()
    .from(outboxMessages)
    .where(eq(outboxMessages.id, OutboxMessageIdSchema.parse(id)));
  return row;
}

/**
 * Claims a pending, due message for one delivery attempt until `leaseUntil`: counts the
 * attempt and hides the message from other workers meanwhile. Returns the claimed row, or
 * `undefined` when it is not there, not pending, not due, or leased by another worker. Commit
 * the claim before delivering, so a second worker sees it.
 */
export async function claimOutboxMessage(
  tx: TenantTx,
  id: OutboxMessageId,
  now: Date,
  leaseUntil: Date,
): Promise<OutboxMessageRow | undefined> {
  const messageId = OutboxMessageIdSchema.parse(id);
  const [row] = await tx
    .update(outboxMessages)
    .set({ attempts: sql`${outboxMessages.attempts} + 1`, leaseUntil })
    .where(
      and(
        eq(outboxMessages.id, messageId),
        eq(outboxMessages.status, 'pending'),
        lte(outboxMessages.availableAt, now),
        or(isNull(outboxMessages.leaseUntil), lte(outboxMessages.leaseUntil, now)),
      ),
    )
    .returning();
  if (row === undefined) return undefined;
  // If the worker dies while delivering, the message is due again when the lease ends.
  await setDispatchTime(tx, messageId, leaseUntil);
  return row;
}

/**
 * Marks a pending message sent and clears its content. Returns whether it was pending (a
 * message already sent or dead is left as it is).
 */
export async function markOutboxMessageSent(
  tx: TenantTx,
  id: OutboxMessageId,
  sentAt: Date,
): Promise<boolean> {
  return finish(tx, id, { status: 'sent', sentAt, lastError: null });
}

/**
 * Records a failed attempt of a pending message: it is due again at `retryAt`, or, with
 * `retryAt` `null`, it is `dead` and its content cleared. `errorName` is an error's name or
 * code, never its message. Returns whether the message was pending.
 */
export async function markOutboxMessageFailed(
  tx: TenantTx,
  id: OutboxMessageId,
  failure: { errorName: string; retryAt: Date | null },
): Promise<boolean> {
  const lastError = ErrorNameSchema.parse(failure.errorName);
  if (failure.retryAt === null) return finish(tx, id, { status: 'dead', sentAt: null, lastError });
  const messageId = OutboxMessageIdSchema.parse(id);
  const updated = await tx
    .update(outboxMessages)
    .set({ availableAt: failure.retryAt, leaseUntil: null, lastError })
    .where(and(eq(outboxMessages.id, messageId), eq(outboxMessages.status, 'pending')))
    .returning({ id: outboxMessages.id });
  if (updated.length === 0) return false;
  await setDispatchTime(tx, messageId, failure.retryAt);
  return true;
}

/** What became of messages an undo tried to take back (ADR-0028). */
export interface OutboxCancellation {
  /** Taken back: they will never be sent. */
  cancelled: OutboxMessageId[];
  /** Too late: a worker is delivering them now, or they were sent or given up already. */
  tooLate: OutboxMessageId[];
}

/**
 * Takes back the transaction's tenant's pending messages among `ids` that no worker is
 * delivering at `now` (no lease, or an ended one): content cleared, dispatch row removed, status
 * `cancelled`. A message being delivered is never half-cancelled; it is reported as too late,
 * like one already sent. Ids the business doesn't have are left out of both lists.
 */
export async function cancelOutboxMessages(
  tx: TenantTx,
  ids: readonly OutboxMessageId[],
  now: Date,
): Promise<OutboxCancellation> {
  const messageIds = z.array(OutboxMessageIdSchema).max(100).parse(ids);
  if (messageIds.length === 0) return { cancelled: [], tooLate: [] };
  const cancelled = await tx
    .update(outboxMessages)
    .set({ status: 'cancelled', payload: null, leaseUntil: null })
    .where(
      and(
        inArray(outboxMessages.id, messageIds),
        eq(outboxMessages.status, 'pending'),
        or(isNull(outboxMessages.leaseUntil), lte(outboxMessages.leaseUntil, now)),
      ),
    )
    .returning({ id: outboxMessages.id });
  const cancelledIds = cancelled.map((row) => OutboxMessageIdSchema.parse(row.id));
  if (cancelledIds.length > 0) {
    await tx.delete(outboxDispatch).where(inArray(outboxDispatch.id, cancelledIds));
  }
  const found = await tx
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(inArray(outboxMessages.id, messageIds));
  const taken = new Set<string>(cancelledIds);
  return {
    cancelled: cancelledIds,
    tooLate: found.map((row) => OutboxMessageIdSchema.parse(row.id)).filter((id) => !taken.has(id)),
  };
}

/** Ends a pending message (sent or dead): content cleared, dispatch row removed. */
async function finish(
  tx: TenantTx,
  id: OutboxMessageId,
  end: { status: 'sent' | 'dead'; sentAt: Date | null; lastError: string | null },
): Promise<boolean> {
  const messageId = OutboxMessageIdSchema.parse(id);
  const updated = await tx
    .update(outboxMessages)
    .set({ ...end, payload: null, leaseUntil: null })
    .where(and(eq(outboxMessages.id, messageId), eq(outboxMessages.status, 'pending')))
    .returning({ id: outboxMessages.id });
  if (updated.length === 0) return false;
  await tx.delete(outboxDispatch).where(eq(outboxDispatch.id, messageId));
  return true;
}

async function setDispatchTime(
  tx: TenantTx,
  messageId: OutboxMessageId,
  availableAt: Date,
): Promise<void> {
  await tx.update(outboxDispatch).set({ availableAt }).where(eq(outboxDispatch.id, messageId));
}
