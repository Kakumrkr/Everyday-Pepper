import { TenantIdSchema, UserIdSchema, type TenantId, type UserId } from '@floty/contracts';
import { sql } from 'drizzle-orm';
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
