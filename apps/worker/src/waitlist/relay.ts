import { TenantIdSchema, WaitlistMatchIdSchema } from '@pepper/contracts';
import { listDueWaitlistMatches, type Database } from '@pepper/db';
import { z } from 'zod';

// The smart waitlist's queue in the worker (S37, ADR-0041), free of BullMQ so it tests alone:
// the relay finds freed times waiting to be matched in Postgres (across businesses, ids only)
// and queues one job per match; the job id is the match id, so a match already queued or
// running is not queued twice. Postgres stays the source of truth: a lost job is found again
// once its lease runs out.

/** The BullMQ queue of waitlist matches. */
export const WAITLIST_QUEUE = 'waitlist';
/** Due matches the relay queues per pass. */
export const WAITLIST_RELAY_BATCH = 100;

/** A match job's data: which freed time, of which business. */
export const MatchJobSchema = z.object({
  matchId: WaitlistMatchIdSchema,
  tenantId: TenantIdSchema,
});
export type MatchJob = z.infer<typeof MatchJobSchema>;

/** The part of a BullMQ `Queue` the relay uses. */
export interface MatchQueue {
  addBulk(
    jobs: {
      name: string;
      data: MatchJob;
      opts: { jobId: string; removeOnComplete: boolean; removeOnFail: boolean };
    }[],
  ): Promise<unknown>;
}

/** Queues a job for each match due at `now`; returns how many were due. */
export async function relayDueMatches(db: Database, queue: MatchQueue, now: Date): Promise<number> {
  const due = await listDueWaitlistMatches(db, now, WAITLIST_RELAY_BATCH);
  if (due.length === 0) return 0;
  await queue.addBulk(
    due.map((match) => ({
      name: 'match',
      data: match,
      opts: { jobId: match.matchId, removeOnComplete: true, removeOnFail: true },
    })),
  );
  return due.length;
}
