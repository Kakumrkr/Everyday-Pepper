import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { invites, outboxDispatch, outboxMessages, sessions, tenants, users } from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Deletion with a grace period (S51.2, ADR-0054). A business or an account is scheduled for a
// day 30 days ahead, can be kept until then, and is deleted for good by the worker after it:
// the business's rows go with its `tenants` row (every tenant table cascades from it, and the
// database refuses that delete before the day, migration 0063); the account's sign-in,
// sessions, second factor and memberships go with its `users` row, other rows name nobody.

const LimitSchema = z.number().int().min(1).max(1000);

/** The message of migration 0063's trigger, when a business isn't due by the database's clock. */
const NOT_DUE = 'this business is not due for deletion';

/** Whether `error` (or an error it wraps) is migration 0063's refusal of an early delete. */
export function isNotDueForDeletion(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if ((current as Error & { code?: unknown }).code === '42501' && current.message === NOT_DUE) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/** When the transaction's business is deleted for good, or `null` when it isn't being deleted. */
export async function findCurrentTenantDeletion(tx: TenantTx): Promise<Date | null> {
  const [row] = await tx
    .select({ dueAt: tenants.deletionDueAt })
    .from(tenants)
    .where(eq(tenants.id, sql`current_tenant_id()`));
  return row?.dueAt ?? null;
}

/**
 * Schedules the transaction's business for deletion at `dueAt`, unless it already is: the day
 * it is deleted, either way (asking twice never moves the day). `undefined` when no business.
 */
export async function scheduleCurrentTenantDeletion(
  tx: TenantTx,
  dueAt: Date,
): Promise<{ dueAt: Date; scheduled: boolean } | undefined> {
  const [updated] = await tx
    .update(tenants)
    .set({ deletionDueAt: dueAt })
    .where(and(eq(tenants.id, sql`current_tenant_id()`), isNull(tenants.deletionDueAt)))
    .returning({ dueAt: tenants.deletionDueAt });
  const scheduled = updated?.dueAt ?? null;
  if (scheduled !== null) return { dueAt: scheduled, scheduled: true };
  const current = await findCurrentTenantDeletion(tx);
  return current === null ? undefined : { dueAt: current, scheduled: false };
}

/** Keeps the transaction's business: whether it was being deleted. */
export async function cancelCurrentTenantDeletion(tx: TenantTx): Promise<boolean> {
  const updated = await tx
    .update(tenants)
    .set({ deletionDueAt: null })
    .where(and(eq(tenants.id, sql`current_tenant_id()`), isNotNull(tenants.deletionDueAt)))
    .returning({ id: tenants.id });
  return updated.length === 1;
}

/**
 * Takes back every email and text of the transaction's business that is waiting to go out and
 * that no worker is sending at `now` (content cleared, status `cancelled`): a business being
 * deleted sends its clients nothing more (ADR-0054; texts since S61). Returns how many.
 */
export async function cancelPendingEmailsAndTexts(
  tx: TenantTx,
  now: Date,
  options: { id?: string } = {},
): Promise<number> {
  const cancelled = await tx
    .update(outboxMessages)
    .set({ status: 'cancelled', payload: null, leaseUntil: null })
    .where(
      and(
        options.id === undefined ? undefined : eq(outboxMessages.id, z.uuid().parse(options.id)),
        // Texts too (S61, ADR-0065): a business being deleted sends its clients nothing more.
        inArray(outboxMessages.type, ['email', 'sms']),
        eq(outboxMessages.status, 'pending'),
        or(isNull(outboxMessages.leaseUntil), lte(outboxMessages.leaseUntil, now)),
      ),
    )
    .returning({ id: outboxMessages.id });
  const ids = cancelled.map((row) => row.id);
  if (ids.length > 0) await tx.delete(outboxDispatch).where(inArray(outboxDispatch.id, ids));
  return ids.length;
}

/** Up to `limit` businesses whose deletion day is at or before `now`, earliest first. */
export async function listTenantsDueForDeletion(
  db: Database,
  now: Date,
  limit: number,
): Promise<TenantId[]> {
  const max = LimitSchema.parse(limit);
  // The clean-up scan (ADR-0025) sees every business's row, read-only and with no tenant set.
  const rows = await withJobScan(db, 'cleanup', (tx) =>
    tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(isNotNull(tenants.deletionDueAt), lte(tenants.deletionDueAt, now)))
      .orderBy(asc(tenants.deletionDueAt), asc(tenants.id))
      .limit(max),
  );
  return rows.map((row) => TenantIdSchema.parse(row.id));
}

/**
 * Deletes the transaction's business for good, with every row of it, if its day is at or
 * before `now` (the database checks the day again against its own clock). Whether it did.
 */
export async function deleteCurrentTenantIfDue(tx: TenantTx, now: Date): Promise<boolean> {
  const deleted = await tx
    .delete(tenants)
    .where(
      and(
        eq(tenants.id, sql`current_tenant_id()`),
        isNotNull(tenants.deletionDueAt),
        lte(tenants.deletionDueAt, now),
      ),
    )
    .returning({ id: tenants.id });
  return deleted.length === 1;
}

// Accounts are global (Better Auth's tables, ADR-0012): no tenant and no RLS.

/** When the account is deleted for good, or `null` when it isn't being deleted. */
export async function findAccountDeletion(db: Database, userId: UserId): Promise<Date | null> {
  const [row] = await db
    .select({ dueAt: users.deletionDueAt })
    .from(users)
    .where(eq(users.id, UserIdSchema.parse(userId)));
  return row?.dueAt ?? null;
}

/**
 * Schedules the account for deletion at `dueAt` (unless it already is) and ends every one of
 * its sessions but `keepSessionId`, in one transaction. The day it is deleted.
 */
export async function scheduleAccountDeletion(
  db: Database,
  userId: UserId,
  dueAt: Date,
  keepSessionId: string,
): Promise<Date> {
  const id = UserIdSchema.parse(userId);
  const keep = z.uuid().parse(keepSessionId);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ deletionDueAt: sql`COALESCE(${users.deletionDueAt}, ${dueAt})` })
      .where(eq(users.id, id))
      .returning({ dueAt: users.deletionDueAt });
    const scheduled = updated?.dueAt ?? null;
    if (scheduled === null) throw new Error('No such account');
    await tx.delete(sessions).where(and(eq(sessions.userId, id), sql`${sessions.id} <> ${keep}`));
    return scheduled;
  });
}

/** Keeps the account: whether it was being deleted. */
export async function cancelAccountDeletion(db: Database, userId: UserId): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ deletionDueAt: null })
    .where(and(eq(users.id, UserIdSchema.parse(userId)), isNotNull(users.deletionDueAt)))
    .returning({ id: users.id });
  return updated.length === 1;
}

/**
 * Ends every session of the account but `keepSessionId` (L15: after a change of email).
 * Returns how many ended.
 */
export async function endOtherSessions(
  db: Database,
  userId: UserId,
  keepSessionId: string,
): Promise<number> {
  const ended = await db
    .delete(sessions)
    .where(
      and(
        eq(sessions.userId, UserIdSchema.parse(userId)),
        sql`${sessions.id} <> ${z.uuid().parse(keepSessionId)}`,
      ),
    )
    .returning({ id: sessions.id });
  return ended.length;
}

/** An account whose deletion day has come. */
export interface DueAccount {
  id: UserId;
  email: string;
}

/** Up to `limit` accounts whose deletion day is at or before `now`, earliest first. */
export async function listAccountsDueForDeletion(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueAccount[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(isNotNull(users.deletionDueAt), lte(users.deletionDueAt, now)))
    .orderBy(asc(users.deletionDueAt), asc(users.id))
    .limit(LimitSchema.parse(limit));
  return rows.map((row) => ({ id: UserIdSchema.parse(row.id), email: row.email }));
}

/**
 * Deletes the transaction's business's invites to `email` (open or accepted): an account that
 * is deleted leaves its address nowhere in a business it belonged to. Returns how many.
 */
export async function deleteInvitesTo(tx: TenantTx, email: string): Promise<number> {
  const deleted = await tx
    .delete(invites)
    .where(eq(invites.email, z.string().min(1).max(320).parse(email).toLowerCase()))
    .returning({ id: invites.id });
  return deleted.length;
}

/**
 * Deletes the account for good if its day is at or before `now`: its sign-in, sessions,
 * second factor, memberships and sign-up record go with it, and the business records it
 * touched keep no link to it (their user ids are set to none). Whether it did.
 */
export async function deleteAccountIfDue(
  db: Database,
  userId: UserId,
  now: Date,
): Promise<boolean> {
  const deleted = await db
    .delete(users)
    .where(
      and(
        eq(users.id, UserIdSchema.parse(userId)),
        isNotNull(users.deletionDueAt),
        lte(users.deletionDueAt, now),
      ),
    )
    .returning({ id: users.id });
  return deleted.length === 1;
}
