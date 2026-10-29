import {
  ActivationKindSchema,
  UserIdSchema,
  type ActivationKind,
  type UserId,
} from '@pepper/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { activationEvents, signupEvents } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Activation events (S45, ADR-0046, AC-W1-10): ids, kinds and times only, each at most once.

/**
 * Records the transaction's business reaching `kind`, unless it already has; `accountId` only
 * with `business_created` (its owner). Returns whether this call recorded it.
 */
export async function recordActivation(
  tx: TenantTx,
  kind: ActivationKind,
  options: { accountId?: UserId } = {},
): Promise<boolean> {
  const accountId = options.accountId === undefined ? null : UserIdSchema.parse(options.accountId);
  const rows = await tx
    .insert(activationEvents)
    .values({ kind: ActivationKindSchema.parse(kind), accountId })
    .onConflictDoNothing({ target: [activationEvents.tenantId, activationEvents.kind] })
    .returning({ id: activationEvents.id });
  return rows.length > 0;
}

/** Whether the transaction's business has reached `kind`. */
export async function hasActivation(tx: TenantTx, kind: ActivationKind): Promise<boolean> {
  const [row] = await tx
    .select({ id: activationEvents.id })
    .from(activationEvents)
    .where(
      and(
        eq(activationEvents.tenantId, sql`current_tenant_id()`),
        eq(activationEvents.kind, ActivationKindSchema.parse(kind)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Whether the transaction's business can be booked: an active service offered by an active
 * staff member who has working hours (scorecard §3's "bookable").
 */
export async function isBusinessBookable(tx: TenantTx): Promise<boolean> {
  const { rows } = await tx.execute<{ bookable: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1
        FROM staff_services ss
        JOIN services s ON s.id = ss.service_id AND s.active
        JOIN staff_members m ON m.id = ss.staff_member_id AND m.active
       WHERE EXISTS (SELECT 1 FROM working_hours w WHERE w.staff_member_id = m.id)
    ) AS bookable`);
  return rows[0]?.bookable === true;
}

/** Records an account's sign-up, once; outside any business's transaction. */
export async function recordSignup(db: Database, accountId: UserId): Promise<void> {
  await db
    .insert(signupEvents)
    .values({ accountId: UserIdSchema.parse(accountId) })
    .onConflictDoNothing({ target: signupEvents.accountId });
}
