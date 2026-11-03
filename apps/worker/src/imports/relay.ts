import { ImportBatchIdSchema, TenantIdSchema } from '@pepper/contracts';
import { listDueImportBatches, type Database } from '@pepper/db';
import { z } from 'zod';

// The client import queue in the worker (S48, ADR-0049), free of BullMQ so it tests alone:
// the relay finds committed imports in Postgres (across businesses, ids only) and queues one
// job per import; the job id is the batch id, so an import already queued or running is not
// queued twice. Postgres stays the source of truth: a lost job is found again once its lease
// runs out.

/** The BullMQ queue of client imports. */
export const IMPORTS_QUEUE = 'imports';
/** Due imports the relay queues per pass. */
export const IMPORTS_RELAY_BATCH = 20;

/** An import job's data: which import, of which business. */
export const ImportJobSchema = z.object({
  batchId: ImportBatchIdSchema,
  tenantId: TenantIdSchema,
});

/** The part of a BullMQ `Queue` the relay uses. */
export interface ImportQueue {
  addBulk(
    jobs: {
      name: string;
      data: z.infer<typeof ImportJobSchema>;
      opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }[],
  ): Promise<unknown>;
}

/** Queues a job for each import due at `now`; returns how many were due. */
export async function relayDueImports(
  db: Database,
  queue: ImportQueue,
  now: Date,
): Promise<number> {
  const due = await listDueImportBatches(db, now, IMPORTS_RELAY_BATCH);
  if (due.length === 0) return 0;
  await queue.addBulk(
    due.map((job) => ({
      name: 'import',
      data: job,
      opts: { jobId: job.batchId, removeOnComplete: true, removeOnFail: true },
    })),
  );
  return due.length;
}
