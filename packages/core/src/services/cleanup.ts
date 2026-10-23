import {
  clearExpiredMemoryPreviousValues,
  deleteExpiredBookingVerifications,
  deleteFinishedOutboxMessages,
  deleteOldMemoryEpisodes,
  listTenantIdsForCleanup,
  withTenant,
  type Database,
} from '@pepper/db';
import { MEMORY_LIMITS, type TenantId } from '@pepper/contracts';
import type { Clock } from '../clock.js';
import { expireProposals } from './ai-actions.js';
import { deleteIdleConversationsIn } from './conversations.js';

// The worker's daily clean-up (ADR-0025, S18 L7): rows nothing needs any more are deleted, so
// less personal data is kept. It lists the businesses and then deletes, under each business's
// tenant and in small batches (short transactions), what is past its retention. It also marks
// the AI's proposals whose time ran out as expired (ADR-0028), so nothing offers them again, and
// deletes conversations with the AI 90 days after their last message (ADR-0030). From Phase 7
// (ADR-0034) it clears memory facts' replaced values once their Undo window ends and deletes
// episodes after a year.

/** How long an expired booking request (name, email, phone) is kept after it expires. */
export const BOOKING_REQUEST_RETENTION_MS = 24 * 60 * 60_000;
/** How long a sent or given-up outbox message (content already cleared) is kept. */
export const OUTBOX_RETENTION_MS = 30 * 24 * 60 * 60_000;

const TENANT_PAGE = 500;
const DELETE_BATCH = 1000;
const EXPIRE_BATCH = 500;
// A conversation takes its turns and messages with it, so its batches are smaller.
const CONVERSATION_BATCH = 100;

export interface CleanupResult {
  businesses: number;
  bookingRequests: number;
  outboxMessages: number;
  expiredProposals: number;
  conversations: number;
  memoryPreviousValues: number;
  memoryEpisodes: number;
}

/** One clean-up pass over every business, as of `clock.now()`. */
export async function cleanUp(db: Database, options: { clock: Clock }): Promise<CleanupResult> {
  const now = options.clock.now().getTime();
  const requestsBefore = new Date(now - BOOKING_REQUEST_RETENTION_MS);
  const outboxBefore = new Date(now - OUTBOX_RETENTION_MS);
  const result: CleanupResult = {
    businesses: 0,
    bookingRequests: 0,
    outboxMessages: 0,
    expiredProposals: 0,
    conversations: 0,
    memoryPreviousValues: 0,
    memoryEpisodes: 0,
  };
  const episodesBefore = new Date(now - MEMORY_LIMITS.episodeRetentionDays * 86_400_000);
  let after: TenantId | null = null;
  for (;;) {
    const page: TenantId[] = await listTenantIdsForCleanup(db, after, TENANT_PAGE);
    for (const tenantId of page) {
      result.bookingRequests += await inBatches(db, tenantId, (tx) =>
        deleteExpiredBookingVerifications(tx, requestsBefore, DELETE_BATCH),
      );
      result.outboxMessages += await inBatches(db, tenantId, (tx) =>
        deleteFinishedOutboxMessages(tx, outboxBefore, DELETE_BATCH),
      );
      result.expiredProposals += await inBatches(
        db,
        tenantId,
        (tx) => expireProposals(tx, new Date(now), EXPIRE_BATCH),
        EXPIRE_BATCH,
      );
      result.conversations += await inBatches(
        db,
        tenantId,
        (tx) => deleteIdleConversationsIn(tx, new Date(now), CONVERSATION_BATCH),
        CONVERSATION_BATCH,
      );
      result.memoryPreviousValues += await inBatches(db, tenantId, (tx) =>
        clearExpiredMemoryPreviousValues(tx, new Date(now), DELETE_BATCH),
      );
      result.memoryEpisodes += await inBatches(db, tenantId, (tx) =>
        deleteOldMemoryEpisodes(tx, episodesBefore, DELETE_BATCH),
      );
    }
    result.businesses += page.length;
    const last = page.at(-1);
    if (page.length < TENANT_PAGE || last === undefined) return result;
    after = last;
  }
}

/** Runs one batch per transaction until a batch handles less than a full batch. */
async function inBatches(
  db: Database,
  tenantId: TenantId,
  batch: Parameters<typeof withTenant<number>>[2],
  size = DELETE_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    const handled = await withTenant(db, tenantId, batch);
    total += handled;
    if (handled < size) return total;
  }
}
