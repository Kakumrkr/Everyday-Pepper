import {
  OutboxDedupeKeySchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  TenantIdSchema,
  type OutboxDedupeKey,
  type OutboxEmailInput,
  type OutboxMessageId,
} from '@pepper/contracts';
import {
  addUsage,
  claimOutboxMessage,
  insertOutboxMessage,
  markOutboxMessageFailed,
  markOutboxMessageSent,
  newId,
  withTenant,
  type Database,
  type DueOutboxMessage,
  type TenantTx,
} from '@pepper/db';
import type { Clock } from '../clock.js';
import { failureOutcome, openOutboxContent, sealOutboxContent, type Mailer } from '../outbox.js';
import { usagePeriodOf } from '../usage-period.js';

// The transactional outbox (ADR-0003, ADR-0024): `queueEmail` runs inside the business
// change's transaction; the worker calls `deliverOutboxMessage` for each due message.

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

/** What one delivery call did. */
export type DeliveryResult = 'sent' | 'retry' | 'dead' | 'skipped';

export interface DeliveryOptions {
  key: Buffer;
  mailer: Mailer;
  clock: Clock;
  leaseMs?: number;
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
  const claimed = await withTenant(db, tenantId, (tx) =>
    claimOutboxMessage(tx, id, claimedAt, leaseUntil),
  );
  if (claimed === undefined || claimed.payload === null) return 'skipped';

  try {
    const content = OutboxEmailSchema.parse(
      JSON.parse(openOutboxContent(options.key, id, claimed.payload).toString('utf8')),
    );
    await options.mailer.send({ ...content, id });
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

  const sentAt = options.clock.now();
  await withTenant(db, tenantId, async (tx) => {
    if (await markOutboxMessageSent(tx, id, sentAt)) {
      await addUsage(tx, { metric: 'emails_sent', amount: 1, period: usagePeriodOf(sentAt) });
    }
  });
  return 'sent';
}
