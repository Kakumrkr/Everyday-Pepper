import { UserIdSchema, type UserId } from '@pepper/contracts';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { supportScreenshots } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Screenshots on support requests (S59.2.3, ADR-0062 Part 3, AC-X-27…31). Rows only: the
// images are in object storage, the limits are the core service's, and who reaches which row is
// the table's RLS (an unsent one: its uploader; a sent one: whoever reaches its thread; an
// operator in a logged transaction: every sent one).

const Id = z.uuid();
const Ids = z.array(Id).max(100);

/** A stored screenshot: its upright size and the widths kept (narrowest first). */
export interface SupportScreenshotRecord {
  id: string;
  tenantId: string;
  uploadedByUserId: string | null;
  threadId: string | null;
  messageId: string | null;
  width: number;
  height: number;
  widths: number[];
  createdAt: Date;
}

const columns = {
  id: supportScreenshots.id,
  tenantId: supportScreenshots.tenantId,
  uploadedByUserId: supportScreenshots.uploadedByUserId,
  threadId: supportScreenshots.threadId,
  messageId: supportScreenshots.messageId,
  width: supportScreenshots.width,
  height: supportScreenshots.height,
  widths: supportScreenshots.widths,
  createdAt: supportScreenshots.createdAt,
};

/** Stores a new, unsent screenshot of the transaction's business, uploaded by `uploadedBy`. */
export async function insertSupportScreenshot(
  tx: TenantTx,
  input: {
    id: string;
    uploadedBy: UserId;
    width: number;
    height: number;
    widths: readonly number[];
    bytes: number;
    now: Date;
  },
): Promise<void> {
  await tx.insert(supportScreenshots).values({
    id: Id.parse(input.id),
    uploadedByUserId: UserIdSchema.parse(input.uploadedBy),
    width: input.width,
    height: input.height,
    widths: [...input.widths],
    bytes: input.bytes,
    createdAt: input.now,
  });
}

/**
 * How many screenshots `userId` uploaded in the business since `since`, discarded ones
 * included (they still count against the day's limit). Run under `lockSupportWriter`.
 */
export async function countSupportScreenshotUploads(
  tx: TenantTx,
  userId: UserId,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(supportScreenshots)
    .where(
      and(
        eq(supportScreenshots.uploadedByUserId, UserIdSchema.parse(userId)),
        gt(supportScreenshots.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

/**
 * The ones of `ids` that `userId` uploaded and may still attach (unsent, not discarded), locked
 * for the attach.
 */
export async function lockAttachableSupportScreenshots(
  tx: TenantTx,
  userId: UserId,
  ids: readonly string[],
): Promise<SupportScreenshotRecord[]> {
  const wanted = Ids.parse([...new Set(ids)]);
  if (wanted.length === 0) return [];
  return tx
    .select(columns)
    .from(supportScreenshots)
    .where(
      and(
        inArray(supportScreenshots.id, wanted),
        eq(supportScreenshots.uploadedByUserId, UserIdSchema.parse(userId)),
        isNull(supportScreenshots.threadId),
        isNull(supportScreenshots.discardedAt),
      ),
    )
    .for('update');
}

/** Attaches locked, unsent screenshots to a message of the thread. Returns how many moved. */
export async function attachSupportScreenshots(
  tx: TenantTx,
  input: { ids: readonly string[]; threadId: string; messageId: string; now: Date },
): Promise<number> {
  const ids = Ids.parse([...new Set(input.ids)]);
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(supportScreenshots)
    .set({
      threadId: Id.parse(input.threadId),
      messageId: Id.parse(input.messageId),
      attachedAt: input.now,
    })
    .where(
      and(
        inArray(supportScreenshots.id, ids),
        isNull(supportScreenshots.threadId),
        isNull(supportScreenshots.discardedAt),
      ),
    )
    .returning({ id: supportScreenshots.id });
  return rows.length;
}

/**
 * Discards `userId`'s unsent screenshot `id` (removed before sending). Returns it, so its images
 * can be deleted, or `undefined` when there is no such unsent screenshot of theirs.
 */
export async function discardSupportScreenshot(
  tx: TenantTx,
  userId: UserId,
  id: string,
  now: Date,
): Promise<SupportScreenshotRecord | undefined> {
  const [row] = await tx
    .update(supportScreenshots)
    .set({ discardedAt: now })
    .where(
      and(
        eq(supportScreenshots.id, Id.parse(id)),
        eq(supportScreenshots.uploadedByUserId, UserIdSchema.parse(userId)),
        isNull(supportScreenshots.threadId),
        isNull(supportScreenshots.discardedAt),
      ),
    )
    .returning(columns);
  return row;
}

/**
 * One screenshot the transaction reaches: a sent one whose thread it reaches, its own unsent
 * one (not discarded), or, for an operator, any sent one. `undefined` otherwise.
 */
export async function findSupportScreenshot(
  tx: TenantTx,
  id: string,
): Promise<SupportScreenshotRecord | undefined> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return undefined;
  const [row] = await tx
    .select(columns)
    .from(supportScreenshots)
    .where(and(eq(supportScreenshots.id, parsed.data), isNull(supportScreenshots.discardedAt)))
    .limit(1);
  return row;
}

/** A thread's screenshots, in the order they were attached (each names its message). */
export async function listSupportScreenshots(
  tx: TenantTx,
  threadId: string,
): Promise<SupportScreenshotRecord[]> {
  return tx
    .select(columns)
    .from(supportScreenshots)
    .where(eq(supportScreenshots.threadId, Id.parse(threadId)))
    .orderBy(
      asc(supportScreenshots.attachedAt),
      asc(supportScreenshots.createdAt),
      asc(supportScreenshots.id),
    );
}

/**
 * Unsent screenshots (discarded or not) uploaded before `before`, across businesses: run in
 * `withJobScan('support')`. At most `limit`, oldest first.
 */
export async function listStaleSupportScreenshots(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<SupportScreenshotRecord[]> {
  return tx
    .select(columns)
    .from(supportScreenshots)
    .where(and(isNull(supportScreenshots.threadId), lt(supportScreenshots.createdAt, before)))
    .orderBy(asc(supportScreenshots.createdAt), asc(supportScreenshots.id))
    .limit(z.number().int().min(1).max(1000).parse(limit));
}

/**
 * Deletes unsent screenshots of the transaction's business uploaded before `before` (the
 * table's policy refuses a sent one). Returns the ones deleted, so their images go too.
 */
export async function deleteStaleSupportScreenshots(
  tx: TenantTx,
  ids: readonly string[],
  before: Date,
): Promise<SupportScreenshotRecord[]> {
  const wanted = Ids.parse([...new Set(ids)]);
  if (wanted.length === 0) return [];
  return tx
    .delete(supportScreenshots)
    .where(
      and(
        inArray(supportScreenshots.id, wanted),
        isNull(supportScreenshots.threadId),
        lt(supportScreenshots.createdAt, before),
      ),
    )
    .returning(columns);
}

/**
 * Every screenshot of the transaction's business, discarded ones included (in case deleting
 * their images failed), for its deletion (ADR-0054). Run without a user.
 */
export async function listAllSupportScreenshots(tx: TenantTx): Promise<SupportScreenshotRecord[]> {
  return tx
    .select(columns)
    .from(supportScreenshots)
    .orderBy(asc(supportScreenshots.createdAt), asc(supportScreenshots.id));
}

/** The business's sent screenshots, for its export (ADR-0053, AC-X-31). */
export async function listSupportScreenshotsForExport(
  tx: TenantTx,
): Promise<SupportScreenshotRecord[]> {
  return tx
    .select(columns)
    .from(supportScreenshots)
    .where(isNotNull(supportScreenshots.threadId))
    .orderBy(asc(supportScreenshots.attachedAt), asc(supportScreenshots.id));
}
