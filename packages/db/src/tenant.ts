import {
  ClientContactSchema,
  TenantIdSchema,
  UserIdSchema,
  type ClientContact,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './client.js';

/** A transaction bound to one tenant: RLS limits every statement in it to that tenant's rows. */
export type TenantTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Runs `work` in a transaction whose tenant is `tenantId`. The setting is transaction-local
 * (`set_config(..., true)`, i.e. `SET LOCAL`), so it ends with the transaction and never
 * reaches the next user of the pooled connection. `tenantId` must come from the authenticated
 * session or a job's stored context, never from request bodies or LLM arguments.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: TenantId,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  // Branded types can be cast; re-check at the boundary to the database, before opening it.
  const id = TenantIdSchema.parse(tenantId);
  return db.transaction(async (tx) => {
    await setTransactionTenant(tx, id);
    return work(tx);
  });
}

/**
 * Runs `work` in a transaction of `member.tenantId` bound to `member.userId` as well, so the
 * restrictive `member_scope` policies limit staff to their own records (ADR-0017, AC-W9-1):
 * their staff member's bookings and waitlist entries, and only those bookings' clients. Owners
 * and managers reach everything. Both ids must come from the authenticated session.
 */
export async function withMember<T>(
  db: Database,
  member: { tenantId: TenantId; userId: UserId },
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const tenantId = TenantIdSchema.parse(member.tenantId);
  const userId = UserIdSchema.parse(member.userId);
  return db.transaction(async (tx) => {
    await setTransactionTenant(tx, tenantId);
    await setTransactionUser(tx, userId);
    return work(tx);
  });
}

/**
 * Binds the open transaction to `tenantId`, transaction-locally. For repository functions
 * that need more than one context in a transaction (`createTenant`); everything else uses
 * `withTenant`.
 */
export async function setTransactionTenant(tx: TenantTx, tenantId: TenantId): Promise<void> {
  const id = TenantIdSchema.parse(tenantId);
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${id}, true)`);
}

/** Binds the open transaction to `userId` (`null` unbinds it), transaction-locally. */
export async function setTransactionUser(tx: TenantTx, userId: UserId | null): Promise<void> {
  const id = userId === null ? '' : UserIdSchema.parse(userId);
  await tx.execute(sql`SELECT set_config('app.user_id', ${id}, true)`);
}

/**
 * Names an exact client email (lowercased) or phone (E.164) for the rest of the open member
 * transaction (`null` clears it): the clients `member_scope` policy then shows staff the
 * clients with exactly that contact too, read-only (ADR-0020). Only a contact the member typed
 * may be passed, never one read from the database.
 */
export async function setTransactionClientContact(
  tx: TenantTx,
  contact: ClientContact | null,
): Promise<void> {
  const value = contact === null ? '' : ClientContactSchema.parse(contact);
  await tx.execute(sql`SELECT set_config('app.client_contact', ${value}, true)`);
}

/**
 * A transaction bound to one signed-in user and no tenant: the `member_read` policies let it
 * read that user's memberships and their businesses across tenants, and nothing else (no
 * writes, no other tenant data).
 */
export type UserTx = TenantTx;

/**
 * Runs `work` in a read-only "my businesses" transaction for `userId` (ADR-0012), e.g. to list
 * the businesses a user may switch to. `userId` must come from the authenticated session.
 */
export async function withUser<T>(
  db: Database,
  userId: UserId,
  work: (tx: UserTx) => Promise<T>,
): Promise<T> {
  const id = UserIdSchema.parse(userId);
  return db.transaction(
    async (tx) => {
      await setTransactionUser(tx, id);
      return work(tx);
    },
    { accessMode: 'read only' },
  );
}

/** A worker job that may scan across businesses through its `job_scan` policy (ADR-0025). */
export type ScanJob = 'reminders' | 'cleanup' | 'tasks' | 'insights' | 'waitlist' | 'imports';

/**
 * Runs `work` in a read-only transaction without a tenant in which the `job_scan` policies of
 * `job` apply: the reminder job sees every business's `booking_reminders` rows (ids and times),
 * the clean-up job every business's `tenants` rows. Nothing else is visible and nothing can be
 * written; the job then handles each business under its own tenant (`withTenant`).
 */
export async function withJobScan<T>(
  db: Database,
  job: ScanJob,
  work: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const name = z.enum(['reminders', 'cleanup', 'tasks', 'insights', 'waitlist', 'imports']).parse(job);
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.job_scan', ${name}, true)`);
      return work(tx);
    },
    { accessMode: 'read only' },
  );
}
