import type { UserId } from '@pepper/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { pushSubscriptions, type PushSubscriptionRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Devices members turned notifications on for (Web Push, ADR-0026), per business. In a
// member's transaction the `member_scope` policy limits them to their own devices; the worker
// and the booking page work without a user and reach all of the business's.

const Id = z.uuid();

export interface NewPushSubscription {
  userId: UserId;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Saves a device for the user; a device already saved for this business (same endpoint)
 * gets the new keys and owner, so a shared device notifies whoever turned it on last.
 */
export async function savePushSubscription(
  tx: TenantTx,
  input: NewPushSubscription,
): Promise<PushSubscriptionRow> {
  const values = {
    userId: Id.parse(input.userId),
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
  };
  const [row] = await tx
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: [pushSubscriptions.tenantId, pushSubscriptions.endpoint],
      set: { userId: values.userId, p256dh: values.p256dh, auth: values.auth },
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... ON CONFLICT DO UPDATE ... RETURNING returns the row
  return row!;
}

/** The transaction's tenant's subscription for this endpoint, if the caller may see it. */
export async function findPushSubscriptionByEndpoint(
  tx: TenantTx,
  endpoint: string,
): Promise<PushSubscriptionRow | undefined> {
  const [row] = await tx
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint));
  return row;
}

export async function findPushSubscription(
  tx: TenantTx,
  id: string,
): Promise<PushSubscriptionRow | undefined> {
  const [row] = await tx
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.id, Id.parse(id)));
  return row;
}

/** Removes the subscription for this endpoint; returns whether there was one. */
export async function deletePushSubscriptionByEndpoint(
  tx: TenantTx,
  endpoint: string,
): Promise<boolean> {
  const rows = await tx
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .returning({ id: pushSubscriptions.id });
  return rows.length > 0;
}

/** Removes a subscription the push service no longer accepts. */
export async function deletePushSubscription(tx: TenantTx, id: string): Promise<void> {
  await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.id, Id.parse(id)));
}

/** The devices of these users in the transaction's tenant, oldest first (at most 100). */
export async function listPushSubscriptionsOf(
  tx: TenantTx,
  userIds: readonly UserId[],
): Promise<PushSubscriptionRow[]> {
  if (userIds.length === 0) return [];
  return tx
    .select()
    .from(pushSubscriptions)
    .where(
      inArray(
        pushSubscriptions.userId,
        userIds.map((id) => Id.parse(id)),
      ),
    )
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
    .limit(100);
}
