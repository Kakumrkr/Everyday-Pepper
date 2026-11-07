import {
  SUPPORT_SCREENSHOT_UNSENT_HOURS,
  SUPPORT_SCREENSHOTS_PER_DAY,
  SupportScreenshotIdSchema,
  SupportScreenshotSchema,
  SupportScreenshotSizeSchema,
  TenantIdSchema,
  type SupportScreenshot,
  type SupportScreenshotSize,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  attachSupportScreenshots,
  countSupportScreenshotUploads,
  deleteStaleSupportScreenshots,
  discardSupportScreenshot as discardScreenshotRow,
  findSupportScreenshot,
  insertSupportScreenshot,
  listAllSupportScreenshots,
  listStaleSupportScreenshots,
  listSupportScreenshots,
  lockAttachableSupportScreenshots,
  lockSupportWriter,
  newId,
  withJobScan,
  withMember,
  withTenant,
  type Database,
  type SupportScreenshotRecord,
  type TenantTx,
} from '@pepper/db';
import { systemClock, type Clock } from '../clock.js';
import type { Actor } from '../actor.js';
import {
  SupportLimitReachedError,
  SupportScreenshotNotFoundError,
  SupportScreenshotRejectedError,
  SupportScreenshotsNotAttachableError,
  SupportScreenshotsUnavailableError,
} from '../errors.js';

// Screenshots on support requests (S59.2.3, ADR-0062 Part 3, AC-X-27…31). A member uploads each
// one on its own; it is checked by its bytes and remade without metadata (the storage port's
// `screenshot` kind), stored under the business's prefix and kept unsent until a request or
// reply names it. Who reaches which screenshot is the table's RLS; the bytes are served only
// through these functions, never from a public address. Images are never logged.

/**
 * Where screenshots are checked and kept: a port, so core never depends on storage (layer
 * rules); `createScreenshotStore` in `@pepper/storage` is the adapter on the object store.
 */
export interface ScreenshotStorage {
  /** Checks an upload by its bytes and remakes it as WebP without metadata, or refuses it. */
  process(bytes: Uint8Array): Promise<
    | {
        kind: 'image';
        width: number;
        height: number;
        /** Narrowest first. */
        variants: { width: number; data: Uint8Array }[];
      }
    | { kind: 'rejected'; reason: string; message: string }
  >;
  put(tenantId: string, id: string, width: number, data: Uint8Array): Promise<void>;
  get(tenantId: string, id: string, width: number): Promise<Uint8Array | null>;
  delete(
    screenshots: readonly { tenantId: string; id: string; widths: readonly number[] }[],
  ): Promise<void>;
}

export interface ScreenshotOptions {
  /** Where the images live (ADR-0048); `null` when no `S3_*` is configured. */
  store: ScreenshotStorage | null;
  clock?: Clock;
}

/** An image as served: always WebP. */
export interface ScreenshotImage {
  body: Uint8Array;
  contentType: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSENT_MS = SUPPORT_SCREENSHOT_UNSENT_HOURS * 60 * 60 * 1000;
// The sweep takes uploads an hour past the window in which they can be sent, so it never
// deletes the images of one being attached at the same moment.
const SWEEP_AFTER_MS = UNSENT_MS + 60 * 60 * 1000;
const WEBP = 'image/webp';
const SWEEP_BATCH = 500;
const EXPORT_READS_AT_ONCE = 4;

function toScreenshot(row: SupportScreenshotRecord): SupportScreenshot {
  return SupportScreenshotSchema.parse({ id: row.id, width: row.width, height: row.height });
}

async function checkUploadLimit(tx: TenantTx, userId: UserId, now: Date): Promise<void> {
  await lockSupportWriter(tx, userId);
  const uploaded = await countSupportScreenshotUploads(
    tx,
    userId,
    new Date(now.getTime() - DAY_MS),
  );
  if (uploaded >= SUPPORT_SCREENSHOTS_PER_DAY) throw new SupportLimitReachedError('screenshots');
}

/**
 * Uploads one screenshot (AC-X-28): 20 a day per person (removed ones count), JPEG, PNG or WebP
 * by content, remade as WebP without metadata at 480 px and up to 2560 px. It stays unsent, seen
 * only by its uploader, until a request or reply attaches it (or the support job sweeps it).
 */
export async function uploadSupportScreenshot(
  db: Database,
  actor: Actor,
  bytes: Uint8Array,
  options: ScreenshotOptions,
): Promise<SupportScreenshot> {
  const { store } = options;
  if (store === null) throw new SupportScreenshotsUnavailableError();
  const clock = options.clock ?? systemClock;
  const { userId, tenantId } = actor.context;
  // Refuse over the limit before decoding anything, then check again under the lock below.
  await withMember(db, actor.context, (tx) => checkUploadLimit(tx, userId, clock.now()));
  const image = await store.process(bytes);
  if (image.kind === 'rejected') {
    throw new SupportScreenshotRejectedError(image.reason, image.message);
  }
  const id = newId();
  const widths = image.variants.map((variant) => variant.width);
  const widest = image.variants.at(-1);
  if (widest === undefined) throw new Error('A screenshot has at least one width');
  try {
    await Promise.all(
      image.variants.map((variant) => store.put(tenantId, id, variant.width, variant.data)),
    );
    await withMember(db, actor.context, async (tx) => {
      const now = clock.now();
      await checkUploadLimit(tx, userId, now);
      await insertSupportScreenshot(tx, {
        id,
        uploadedBy: userId,
        width: image.width,
        height: image.height,
        widths,
        bytes: widest.data.byteLength,
        now,
      });
    });
  } catch (error) {
    // Nothing points at the images (or a put failed): take back every width, as the sweep
    // can't find them without a row.
    await store.delete([{ tenantId, id, widths }]).catch(() => undefined);
    throw error;
  }
  return SupportScreenshotSchema.parse({ id, width: image.width, height: image.height });
}

/**
 * Removes the member's own unsent screenshot before sending (AC-X-27). Its row stays, discarded,
 * so the day's count holds; its images go now (or with the sweep, if the store fails).
 */
export async function discardSupportScreenshot(
  db: Database,
  actor: Actor,
  screenshotId: string,
  options: ScreenshotOptions,
): Promise<void> {
  const id = parseScreenshotId(screenshotId);
  const now = (options.clock ?? systemClock).now();
  const row = await withMember(db, actor.context, (tx) =>
    discardScreenshotRow(tx, actor.context.userId, id, now),
  );
  if (row === undefined) throw new SupportScreenshotNotFoundError();
  await options.store?.delete([row]).catch(() => undefined);
}

/**
 * Attaches the sender's own unsent screenshots to their new message, in the order named
 * (AC-X-27). Any other id (someone else's, already sent, removed, swept) refuses the whole
 * message: nothing is sent without the screenshots the sender sees in their draft.
 */
export async function attachScreenshotsToMessage(
  tx: TenantTx,
  input: {
    userId: UserId;
    screenshotIds: readonly string[];
    threadId: string;
    messageId: string;
    now: Date;
  },
): Promise<number> {
  if (input.screenshotIds.length === 0) return 0;
  const locked = await lockAttachableSupportScreenshots(
    tx,
    input.userId,
    input.screenshotIds,
    new Date(input.now.getTime() - UNSENT_MS),
  );
  if (locked.length !== new Set(input.screenshotIds).size) {
    throw new SupportScreenshotsNotAttachableError();
  }
  // One at a time so `attached_at` keeps the order the sender chose.
  let attached = 0;
  for (const [index, id] of input.screenshotIds.entries()) {
    attached += await attachSupportScreenshots(tx, {
      ids: [id],
      threadId: input.threadId,
      messageId: input.messageId,
      now: new Date(input.now.getTime() + index),
    });
  }
  if (attached !== locked.length) throw new SupportScreenshotsNotAttachableError();
  return attached;
}

/** A thread's screenshots by message, in the order they were attached. */
export async function screenshotsByMessage(
  tx: TenantTx,
  threadId: string,
): Promise<Map<string, SupportScreenshot[]>> {
  const byMessage = new Map<string, SupportScreenshot[]>();
  for (const row of await listSupportScreenshots(tx, threadId)) {
    if (row.messageId === null) continue;
    const list = byMessage.get(row.messageId) ?? [];
    list.push(toScreenshot(row));
    byMessage.set(row.messageId, list);
  }
  return byMessage;
}

/**
 * A screenshot's image for a member (AC-X-29): a sent one whose thread they may read, or their
 * own unsent upload (its preview). Anything else, or a missing image, is "not found".
 */
export async function readSupportScreenshotImage(
  db: Database,
  actor: Actor,
  screenshotId: string,
  size: SupportScreenshotSize,
  options: ScreenshotOptions,
): Promise<ScreenshotImage> {
  const id = parseScreenshotId(screenshotId);
  const row = await withMember(db, actor.context, (tx) => findSupportScreenshot(tx, id));
  return imageOf(row, size, options.store);
}

/** The stored image of `row` at `size`: the narrowest width for `thumb`, the widest for `full`. */
export async function imageOf(
  row: SupportScreenshotRecord | undefined,
  size: SupportScreenshotSize,
  store: ScreenshotStorage | null,
): Promise<ScreenshotImage> {
  if (row === undefined || store === null) throw new SupportScreenshotNotFoundError();
  const width =
    SupportScreenshotSizeSchema.parse(size) === 'thumb' ? row.widths[0] : row.widths.at(-1);
  if (width === undefined) throw new SupportScreenshotNotFoundError();
  const body = await store.get(row.tenantId, row.id, width);
  if (body === null) throw new SupportScreenshotNotFoundError();
  return { body, contentType: WEBP };
}

/**
 * The support job's sweep (AC-X-28): unsent screenshots (removed or never sent) that can't be
 * sent any more (24 h, plus an hour's margin) lose their rows and images. Found across businesses with the read-only job scan, deleted
 * bound to each business. Returns how many rows went.
 */
export async function sweepUnsentSupportScreenshots(
  db: Database,
  options: ScreenshotOptions,
): Promise<number> {
  const before = new Date((options.clock ?? systemClock).now().getTime() - SWEEP_AFTER_MS);
  const stale = await withJobScan(db, 'support', (tx) =>
    listStaleSupportScreenshots(tx, before, SWEEP_BATCH),
  );
  const byTenant = new Map<string, string[]>();
  for (const row of stale)
    byTenant.set(row.tenantId, [...(byTenant.get(row.tenantId) ?? []), row.id]);
  let swept = 0;
  for (const [tenant, ids] of byTenant) {
    const tenantId = TenantIdSchema.parse(tenant);
    // Images first: a failed store keeps the rows, so the next pass tries again.
    const rows = stale.filter((row) => row.tenantId === tenant);
    if (options.store === null) continue;
    await options.store.delete(rows);
    swept += (
      await withTenant(db, tenantId, (tx) => deleteStaleSupportScreenshots(tx, ids, before))
    ).length;
  }
  return swept;
}

/**
 * Deletes every stored image of the business's screenshots before the business itself goes
 * (ADR-0054, AC-X-31); the rows go with it by cascade. Throws when they can't be deleted, so the
 * business waits for the next pass rather than leaving images behind.
 */
export async function deleteAllSupportScreenshotImages(
  db: Database,
  tenantId: TenantId,
  store: ScreenshotStorage | null,
): Promise<number> {
  const rows = await withTenant(db, tenantId, listAllSupportScreenshots);
  if (rows.length === 0) return 0;
  if (store === null) throw new Error('No object store to delete the screenshots from');
  await store.delete(rows);
  return rows.length;
}

/**
 * The full-width images of the business's sent screenshots, for its export (AC-X-31). A missing
 * image (or no store) is left out; the export lists it by name either way.
 */
export async function readScreenshotsForExport(
  tenantId: TenantId,
  screenshots: readonly { id: string; widths: readonly number[] }[],
  store: ScreenshotStorage | null,
): Promise<Map<string, Uint8Array>> {
  const images = new Map<string, Uint8Array>();
  if (store === null) return images;
  // A few at a time: quick for a big export without a burst of requests.
  const queue = [...screenshots];
  const worker = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const width = next.widths.at(-1);
      if (width === undefined) continue;
      const stored = await store.get(tenantId, next.id, width);
      if (stored !== null) images.set(next.id, stored);
    }
  };
  await Promise.all(Array.from({ length: EXPORT_READS_AT_ONCE }, worker));
  return images;
}

function parseScreenshotId(screenshotId: string): string {
  const parsed = SupportScreenshotIdSchema.safeParse(screenshotId);
  if (!parsed.success) throw new SupportScreenshotNotFoundError();
  return parsed.data;
}
