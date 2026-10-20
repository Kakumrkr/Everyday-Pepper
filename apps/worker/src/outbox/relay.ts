import { OutboxMessageIdSchema, TenantIdSchema } from '@pepper/contracts';
import { deliverOutboxMessage, type DeliveryOptions, type DeliveryResult } from '@pepper/core';
import { listDueOutboxMessages, type Database } from '@pepper/db';
import { z } from 'zod';

// The outbox's two halves in the worker (ADR-0024), free of BullMQ so they test alone: the
// relay finds due messages in Postgres and queues one job per message; the handler delivers
// the message a job names. Jobs carry ids only; Postgres stays the source of truth.

/** The BullMQ queue of outbox deliveries. */
export const OUTBOX_QUEUE = 'outbox';
/** Due messages the relay queues per pass. */
export const RELAY_BATCH = 100;

/** A delivery job's data: which message, of which business (from the dispatch index). */
export const DeliveryJobSchema = z.object({
  messageId: OutboxMessageIdSchema,
  tenantId: TenantIdSchema,
});
export type DeliveryJob = z.infer<typeof DeliveryJobSchema>;

/** The part of a BullMQ `Queue` the relay uses. */
export interface JobQueue {
  addBulk(
    jobs: {
      name: string;
      data: DeliveryJob;
      opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }[],
  ): Promise<unknown>;
}

/**
 * Queues a job for each message due at `now`. The job id is the message id, so a message
 * already waiting or running is not queued twice; finished jobs are removed, so a message due
 * again (a retry, an expired lease) gets a new job. Returns how many messages were due.
 */
export async function relayDue(db: Database, queue: JobQueue, now: Date): Promise<number> {
  const due = await listDueOutboxMessages(db, now, RELAY_BATCH);
  if (due.length === 0) return 0;
  await queue.addBulk(
    due.map((message) => ({
      name: 'deliver',
      data: message,
      opts: { jobId: message.messageId, removeOnComplete: true, removeOnFail: true },
    })),
  );
  return due.length;
}

/**
 * Delivers the message a job names (at most once, see `deliverOutboxMessage`). Malformed job
 * data is refused: jobs only come from the relay.
 */
export function handleDeliveryJob(
  db: Database,
  data: unknown,
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  return deliverOutboxMessage(db, DeliveryJobSchema.parse(data), options);
}
