import { TenantIdSchema, type TenantId } from '@pepper/contracts';
import { and, asc, gt, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { bookingVerifications, outboxMessages, tenants } from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// The worker's daily clean-up (ADR-0025): it lists the businesses (`job_scan`, ids only) and
// then deletes, under each business's tenant and in batches, the rows nothing needs any more.

const LimitSchema = z.number().int().min(1).max(10_000);

/** Up to `limit` business ids after `after` (exclusive), in id order: one page of the scan. */
export async function listTenantIdsForCleanup(
  db: Database,
  after: TenantId | null,
  limit: number,
): Promise<TenantId[]> {
  const max = LimitSchema.parse(limit);
  const rows = await withJobScan(db, 'cleanup', (tx) =>
    tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(after === null ? undefined : gt(tenants.id, TenantIdSchema.parse(after)))
      .orderBy(asc(tenants.id))
      .limit(max),
  );
  return rows.map((row) => TenantIdSchema.parse(row.id));
}

/**
 * Deletes up to `limit` of the transaction's tenant's booking requests that expired before
 * `before` (with the client's name, email and phone, S18 L7). Returns how many it deleted.
 */
export async function deleteExpiredBookingVerifications(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const max = LimitSchema.parse(limit);
  const batch = tx
    .select({ id: bookingVerifications.id })
    .from(bookingVerifications)
    .where(lt(bookingVerifications.expiresAt, before))
    .limit(max);
  const deleted = await tx
    .delete(bookingVerifications)
    .where(inArray(bookingVerifications.id, batch))
    .returning({ id: bookingVerifications.id });
  return deleted.length;
}

/**
 * Deletes up to `limit` of the transaction's tenant's outbox messages that were sent, given
 * up or cancelled (their content is already cleared) before `before`. Pending messages are
 * never touched. Returns how many it deleted.
 */
export async function deleteFinishedOutboxMessages(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const max = LimitSchema.parse(limit);
  const batch = tx
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        inArray(outboxMessages.status, ['sent', 'dead', 'cancelled']),
        lt(outboxMessages.updatedAt, before),
      ),
    )
    .limit(max);
  const deleted = await tx
    .delete(outboxMessages)
    .where(inArray(outboxMessages.id, batch))
    .returning({ id: outboxMessages.id });
  return deleted.length;
}
