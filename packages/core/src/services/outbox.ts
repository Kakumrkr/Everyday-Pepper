import {
  OutboxDedupeKeySchema,
  OutboxEmailSchema,
  OutboxEpisodeSchema,
  OutboxMessageIdSchema,
  OutboxPushSchema,
  TenantIdSchema,
  type OutboxDedupeKey,
  type OutboxEpisode,
  type TenantId,
  type OutboxEmailInput,
  type OutboxMessageId,
  type OutboxPushInput,
} from '@pepper/contracts';
import {
  addUsage,
  cancelPendingOutboxEmails,
  claimOutboxMessage,
  findCurrentTenantDeletion,
  deletePushSubscription,
  findPushSubscription,
  insertOutboxMessage,
  markOutboxMessageFailed,
  markOutboxMessageSent,
  newId,
  withTenant,
  type Database,
  type DueOutboxMessage,
  type TenantTx,
  isSupportMailStopped,
} from '@pepper/db';
import type { Clock } from '../clock.js';
import {
  ChannelUnavailableError,
  failureOutcome,
  isGonePush,
  openOutboxContent,
  sealOutboxContent,
  type Mailer,
  type Pusher,
} from '../outbox.js';
import { usagePeriodOf } from '../usage-period.js';

// The transactional outbox (ADR-0003, ADR-0024): `queueEmail` and `queuePush` (ADR-0026) run
// inside the business change's transaction; the worker calls `deliverOutboxMessage` for each
// due message.

/** How long a claimed message is hidden from other workers while one delivers it. */
export const OUTBOX_LEASE_MS = 5 * 60_000;

/**
 * Queues an email in the open transaction of a business, so it is sent if and only if the
 * change commits. The content is sealed with `key`. Returns the message id, or `undefined`
 * when the business already queued a message with this dedupe key (nothing is queued then).
 */
export async function queueEmail(
  tx: TenantTx,
  email: OutboxEmailInput,
  options: { key: Buffer; dedupeKey: OutboxDedupeKey; now: Date },
): Promise<OutboxMessageId | undefined> {
  const content = OutboxEmailSchema.parse(email);
  const id = OutboxMessageIdSchema.parse(newId());
  const row = await insertOutboxMessage(tx, {
    id,
    type: 'email',
    dedupeKey: OutboxDedupeKeySchema.parse(options.dedupeKey),
    payload: sealOutboxContent(options.key, id, Buffer.from(JSON.stringify(content))),
    availableAt: options.now,
  });
  return row === undefined ? undefined : id;
}

/**
 * Queues a push to one device (`OutboxPushSchema`) in the open transaction of a business,
 * like `queueEmail`. Returns the message id, or `undefined` for a dedupe key already used.
 */
export async function queuePush(
  tx: TenantTx,
  push: OutboxPushInput,
  options: { key: Buffer; dedupeKey: OutboxDedupeKey; now: Date },
): Promise<OutboxMessageId | undefined> {
  const content = OutboxPushSchema.parse(push);
  const id = OutboxMessageIdSchema.parse(newId());
  const row = await insertOutboxMessage(tx, {
    id,
    type: 'push',
    dedupeKey: OutboxDedupeKeySchema.parse(options.dedupeKey),
    payload: sealOutboxContent(options.key, id, Buffer.from(JSON.stringify(content))),
    availableAt: options.now,
  });
  return row === undefined ? undefined : id;
}

/**
 * What one delivery call did. `dropped`: a push whose device is gone (the member turned it
 * off, or the push service no longer knows it); nothing is wrong, so nothing is alerted.
 */
/** `cancelled`: an email of a business being deleted, taken back unsent (ADR-0054). */
export type DeliveryResult = 'sent' | 'retry' | 'dead' | 'skipped' | 'dropped' | 'cancelled';

/**
 * Writes the episode an outbox message names (S31, ADR-0037): `@pepper/ai`'s writer, given by
 * the worker. It throws to be retried (the model, the embedding, a changed conversation).
 */
export type EpisodeWriter = (
  db: Database,
  tenantId: TenantId,
  job: OutboxEpisode,
) => Promise<unknown>;

export interface DeliveryOptions {
  key: Buffer;
  mailer: Mailer;
  /**
   * `null` or absent: this worker writes no episodes, so a queued one fails (and retries, then
   * gives up with an alert): the api queues them only when an embedding model is configured.
   */
  episodes?: EpisodeWriter | null;
  /**
   * `null` or absent: this worker has no VAPID keys, so a queued push fails (and retries,
   * then gives up with an alert): the api queues pushes only when push is configured, so
   * that means the api and the worker are configured differently.
   */
  pusher?: Pusher | null;
  clock: Clock;
  leaseMs?: number;
}

/** How long a push service may hold a push for an offline device: a day. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

/**
 * Support email to a requester (S59.3.2, AC-X-42): the team's answers, the quiet close and the
 * notes about an emailed reply. These stop for an address that bounced for good or complained;
 * the team's own copies (`support.opened`, `support.replied`, `support.overdue`) never do.
 */
const REQUESTER_SUPPORT_MAIL = ['support.answered:', 'support.closed:', 'support.inbound_note:'];

export function isRequesterSupportMail(dedupeKey: string): boolean {
  return REQUESTER_SUPPORT_MAIL.some((prefix) => dedupeKey.startsWith(prefix));
}

/**
 * Delivers one due message at most once: claims it (committed, so no other worker gets it
 * during the lease), opens and sends it, then marks it sent and meters the email in one
 * transaction. A failure schedules a retry or gives up (`failureOutcome`). `skipped`: the
 * message was sent, dead, not due or leased by another worker. If the process dies after
 * the mail server accepted the email but before it is marked sent, the email is sent again
 * after the lease (with the same `Message-ID`); ADR-0024 names this limit.
 */
export async function deliverOutboxMessage(
  db: Database,
  due: DueOutboxMessage,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  const tenantId = TenantIdSchema.parse(due.tenantId);
  const id = OutboxMessageIdSchema.parse(due.messageId);
  const claimedAt = options.clock.now();
  const leaseUntil = new Date(claimedAt.getTime() + (options.leaseMs ?? OUTBOX_LEASE_MS));
  const claimed = await withTenant(db, tenantId, async (tx) => {
    // A business being deleted sends no more email (S51.2, ADR-0054): it is taken back.
    if (
      (await findCurrentTenantDeletion(tx)) !== null &&
      (await cancelPendingOutboxEmails(tx, claimedAt, { id })) > 0
    ) {
      return 'cancelled' as const;
    }
    return claimOutboxMessage(tx, id, claimedAt, leaseUntil);
  });
  if (claimed === 'cancelled') return 'cancelled';
  if (claimed === undefined || claimed.payload === null) return 'skipped';

  let dropped = false;
  let stopped = false;
  try {
    const opened: unknown = JSON.parse(
      openOutboxContent(options.key, id, claimed.payload).toString('utf8'),
    );
    if (claimed.type === 'push') {
      dropped = !(await sendPush(db, tenantId, opened, options));
    } else if (claimed.type === 'episode') {
      const writer = options.episodes ?? null;
      if (writer === null) throw new ChannelUnavailableError('episode');
      await writer(db, tenantId, OutboxEpisodeSchema.parse(opened));
    } else {
      const content = OutboxEmailSchema.parse(opened);
      if (
        isRequesterSupportMail(claimed.dedupeKey) &&
        (await isSupportMailStopped(db, content.to))
      ) {
        // The address bounced for good or complained (S59.3.2, AC-X-42): kept as a record, never sent.
        stopped = true;
      } else {
        await options.mailer.send({ ...content, id });
      }
    }
  } catch (error) {
    const outcome = failureOutcome(error, claimed.attempts, options.clock.now());
    await withTenant(db, tenantId, (tx) =>
      markOutboxMessageFailed(tx, id, {
        errorName: outcome.errorName,
        retryAt: outcome.kind === 'retry' ? outcome.retryAt : null,
      }),
    );
    return outcome.kind;
  }

  if (dropped) {
    await withTenant(db, tenantId, (tx) =>
      markOutboxMessageFailed(tx, id, { errorName: 'PushSubscriptionGone', retryAt: null }),
    );
    return 'dropped';
  }
  if (stopped) {
    await withTenant(db, tenantId, (tx) =>
      markOutboxMessageFailed(tx, id, { errorName: 'SupportMailStopped', retryAt: null }),
    );
    return 'dropped';
  }
  const sentAt = options.clock.now();
  await withTenant(db, tenantId, async (tx) => {
    if ((await markOutboxMessageSent(tx, id, sentAt)) && claimed.type === 'email') {
      await addUsage(tx, { metric: 'emails_sent', amount: 1, period: usagePeriodOf(sentAt) });
    }
  });
  return 'sent';
}

/**
 * Sends one queued push to its device. Returns `false` when the device is gone: the member
 * turned notifications off (no subscription), or the push service answered 404/410 (the
 * subscription is removed then). Other failures throw, for `failureOutcome`.
 */
async function sendPush(
  db: Database,
  tenantId: ReturnType<typeof TenantIdSchema.parse>,
  opened: unknown,
  options: DeliveryOptions,
): Promise<boolean> {
  const push = OutboxPushSchema.parse(opened);
  const pusher = options.pusher ?? null;
  if (pusher === null) throw new ChannelUnavailableError('push');
  // Work without a user reaches every device of the business.
  const subscription = await withTenant(db, tenantId, (tx) =>
    findPushSubscription(tx, push.subscriptionId),
  );
  if (subscription === undefined) return false;
  const { title, body, url, tag } = push;
  try {
    await pusher.send({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      payload: JSON.stringify({ title, body, url, ...(tag !== undefined && { tag }) }),
      ttlSeconds: PUSH_TTL_SECONDS,
    });
  } catch (error) {
    if (!isGonePush(error)) throw error;
    await withTenant(db, tenantId, (tx) => deletePushSubscription(tx, subscription.id));
    return false;
  }
  return true;
}
