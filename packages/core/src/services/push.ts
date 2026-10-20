import {
  OutboxDedupeKeySchema,
  PushEndpointSchema,
  PushSubscriptionInputSchema,
  UserIdSchema,
  type OutboxDedupeKey,
  type OutboxMessageId,
  type PushEndpoint,
  type PushSubscriptionInput,
  type UserId,
} from '@pepper/contracts';
import {
  deletePushSubscriptionByEndpoint,
  findPushSubscriptionByEndpoint,
  listMemberships,
  listPushSubscriptionsOf,
  savePushSubscription,
  withMember,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { queuePush } from './outbox.js';

// Web Push for the installed app (ADR-0026). A member turns notifications on or off for the
// device they use, per business; each member reaches only their own devices. Changes that
// notify the team call `queuePushToMembers` inside their transaction, so a push is sent if and
// only if the change commits, through the outbox like an email.

/** Turns this device's notifications on for the member in the active business. */
export async function savePushDevice(
  db: Database,
  actor: Actor,
  input: PushSubscriptionInput,
): Promise<void> {
  requirePermission(actor, 'business.read');
  const { endpoint, keys } = PushSubscriptionInputSchema.parse(input);
  await withMember(db, actor.context, (tx) =>
    savePushSubscription(tx, { userId: actor.context.userId, endpoint, ...keys }),
  );
}

/** Turns them off; a device that was not on is fine. */
export async function removePushDevice(
  db: Database,
  actor: Actor,
  device: PushEndpoint,
): Promise<void> {
  requirePermission(actor, 'business.read');
  const { endpoint } = PushEndpointSchema.parse(device);
  await withMember(db, actor.context, (tx) => deletePushSubscriptionByEndpoint(tx, endpoint));
}

/** Whether this device gets the member's pushes from the active business. */
export async function pushDeviceStatus(
  db: Database,
  actor: Actor,
  device: PushEndpoint,
): Promise<boolean> {
  requirePermission(actor, 'business.read');
  const { endpoint } = PushEndpointSchema.parse(device);
  const row = await withMember(db, actor.context, (tx) =>
    findPushSubscriptionByEndpoint(tx, endpoint),
  );
  return row !== undefined;
}

/** A notification for members' devices. Never a client's name (it shows on lock screens). */
export interface PushNotice {
  title: string;
  body: string;
  /** The app page to open, e.g. `/calendar?date=2026-11-03`. */
  url: string;
  tag?: string;
}

/**
 * Queues `notice` to every device of these members in the transaction's business, one outbox
 * message per device (`<dedupeKey>:<device id>`, so a retried change queues nothing twice).
 * Returns the ids of the messages queued. Run in a transaction that reaches the members' devices: work
 * without a user (jobs, the booking page) or the member's own.
 */
export async function queuePushToMembers(
  tx: TenantTx,
  userIds: readonly UserId[],
  notice: PushNotice,
  options: { key: Buffer; dedupeKey: OutboxDedupeKey; now: Date },
): Promise<OutboxMessageId[]> {
  const unique = [...new Set(userIds.map((id) => UserIdSchema.parse(id)))];
  const devices = await listPushSubscriptionsOf(tx, unique);
  const queued: OutboxMessageId[] = [];
  for (const device of devices) {
    const id = await queuePush(
      tx,
      { subscriptionId: device.id, ...notice },
      {
        key: options.key,
        dedupeKey: OutboxDedupeKeySchema.parse(`${options.dedupeKey}:${device.id}`),
        now: options.now,
      },
    );
    if (id !== undefined) queued.push(id);
  }
  return queued;
}

/** The business's owners and managers: who hears about what happens on the booking page. */
export async function leadUserIds(tx: TenantTx): Promise<UserId[]> {
  return (await listMemberships(tx))
    .filter((membership) => membership.role === 'owner' || membership.role === 'manager')
    .map((membership) => UserIdSchema.parse(membership.userId));
}
