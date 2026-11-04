import {
  BusinessPhotoIdSchema,
  BusinessPhotoKindSchema,
  MAX_GALLERY_PHOTOS,
  PhotoCaptionSchema,
  TenantSlugSchema,
  UtcDateTimeSchema,
  type BusinessPhoto,
  type BusinessPhotoKind,
  type BusinessPhotos,
  type PublicPhoto,
  type TenantId,
  type TenantSlug,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  countBusinessPhotos,
  deleteBusinessPhoto,
  deleteBusinessPhotosOfKind,
  findBusinessPhoto,
  insertBusinessPhoto,
  listBusinessPhotos,
  lockBusinessPhotos,
  newId,
  updateBusinessPhotoCaption,
  withMember,
  withPublicTenant,
  withTenant,
  type BusinessPhotoRow,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { photoObjectKey, processImage, type ObjectStore } from '@pepper/storage';
import { GalleryFullError, PhotoNotFoundError } from '../errors.js';

// The booking page's photos (S47.2, ADR-0048, AC-W8-10…12). Owners and managers
// (`settings.manage`) add a logo, a cover and up to 12 gallery photos; the page shows them.
// Images are checked and remade by `@pepper/storage` before anything is stored, written to the
// object store before their row, and deleted again if the row's transaction fails; a replaced
// or removed photo's images are deleted after its transaction commits.

export interface PhotoStorageOptions {
  store: ObjectStore;
  /** Told when stored images could not be deleted (they stay, unreachable; nothing breaks). */
  onCleanupError?: (error: unknown) => void;
}

function toPublicPhoto(row: BusinessPhotoRow): PublicPhoto {
  return {
    id: BusinessPhotoIdSchema.parse(row.id),
    widths: [...row.widths],
    width: row.width,
    height: row.height,
    caption: row.caption,
  };
}

function toBusinessPhoto(row: BusinessPhotoRow): BusinessPhoto {
  return {
    ...toPublicPhoto(row),
    kind: BusinessPhotoKindSchema.parse(row.kind),
    createdAt: UtcDateTimeSchema.parse(row.createdAt.toISOString()),
  };
}

/** The rows as the page shows them: the logo, the cover and the gallery, oldest first. */
export async function businessPhotosIn(tx: TenantTx): Promise<BusinessPhotos> {
  const rows = await listBusinessPhotos(tx);
  const one = (kind: BusinessPhotoKind) => {
    const row = rows.find((candidate) => candidate.kind === kind);
    return row === undefined ? null : toPublicPhoto(row);
  };
  return {
    logo: one('logo'),
    cover: one('cover'),
    gallery: rows.filter((row) => row.kind === 'gallery').map(toPublicPhoto),
  };
}

/** The actor's business's photos. */
export async function listPhotos(db: Database, actor: Actor): Promise<BusinessPhotos> {
  requirePermission(actor, 'settings.manage');
  return withMember(db, actor.context, businessPhotosIn);
}

function objectKeys(tenantId: string, row: Pick<BusinessPhotoRow, 'id' | 'widths'>): string[] {
  return row.widths.map((width) => photoObjectKey(tenantId, row.id, width));
}

async function deleteObjects(options: PhotoStorageOptions, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await options.store.delete(keys);
  } catch (error) {
    options.onCleanupError?.(error);
  }
}

/**
 * Adds a photo of `kind` from an upload's bytes (AC-W8-10/11): checked by content, upright,
 * without metadata, at the kind's widths. A new logo or cover replaces the old one; a 13th
 * gallery photo is refused (`GalleryFullError`). Throws `ImageRejectedError` for a file that
 * isn't a usable photo.
 */
export async function addPhoto(
  db: Database,
  actor: Actor,
  upload: { kind: BusinessPhotoKind; bytes: Uint8Array; caption?: string | null },
  options: PhotoStorageOptions,
): Promise<BusinessPhoto> {
  requirePermission(actor, 'settings.manage');
  const kind = BusinessPhotoKindSchema.parse(upload.kind);
  const caption = PhotoCaptionSchema.nullable().parse(upload.caption ?? null);
  const tenantId = actor.context.tenantId;
  // Refused before the work of resizing when the gallery is full; checked again under the lock.
  if (kind === 'gallery') {
    const held = await withMember(db, actor.context, (tx) => countBusinessPhotos(tx, 'gallery'));
    if (held >= MAX_GALLERY_PHOTOS) throw new GalleryFullError();
  }
  const image = await processImage(upload.bytes, kind);
  const id = newId();
  const widths = image.variants.map((variant) => variant.width);
  const keys = objectKeys(tenantId, { id, widths });
  try {
    await Promise.all(
      image.variants.map((variant, index) =>
        options.store.put(keys[index] ?? '', variant.data, 'image/webp'),
      ),
    );
  } catch (error) {
    await deleteObjects(options, keys);
    throw error;
  }
  let added: { row: BusinessPhotoRow; replaced: BusinessPhotoRow[] };
  try {
    added = await withMember(db, actor.context, async (tx) => {
      await lockBusinessPhotos(tx);
      if (kind === 'gallery' && (await countBusinessPhotos(tx, 'gallery')) >= MAX_GALLERY_PHOTOS) {
        throw new GalleryFullError();
      }
      const replaced = kind === 'gallery' ? [] : await deleteBusinessPhotosOfKind(tx, kind);
      for (const old of replaced) {
        await appendAuditEntry(tx, {
          actor: auditActorOf(actor),
          change: {
            action: 'business_photo.removed',
            entity: { type: 'business_photo', id: old.id },
            before: { kind },
            after: null,
          },
          requestId: actor.requestId,
        });
      }
      const row = await insertBusinessPhoto(tx, {
        id,
        kind,
        widths,
        width: image.width,
        height: image.height,
        caption,
      });
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'business_photo.added',
          entity: { type: 'business_photo', id: row.id },
          before: null,
          after: { kind },
        },
        requestId: actor.requestId,
      });
      return { row, replaced };
    });
  } catch (error) {
    await deleteObjects(options, keys);
    throw error;
  }
  await deleteObjects(
    options,
    added.replaced.flatMap((old) => objectKeys(tenantId, old)),
  );
  return toBusinessPhoto(added.row);
}

/** Sets or clears a photo's caption (its alt text). */
export async function changePhotoCaption(
  db: Database,
  actor: Actor,
  photoId: string,
  caption: string | null,
): Promise<BusinessPhoto> {
  requirePermission(actor, 'settings.manage');
  const id = BusinessPhotoIdSchema.safeParse(photoId);
  if (!id.success) throw new PhotoNotFoundError();
  const next = PhotoCaptionSchema.nullable().parse(caption);
  return withMember(db, actor.context, async (tx) => {
    const before = await findBusinessPhoto(tx, id.data);
    if (before === undefined) throw new PhotoNotFoundError();
    if (before.caption === next) return toBusinessPhoto(before);
    const after = await updateBusinessPhotoCaption(tx, id.data, next);
    if (after === undefined) throw new PhotoNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'business_photo.updated',
        entity: { type: 'business_photo', id: after.id },
        before: { captioned: before.caption !== null },
        after: { captioned: after.caption !== null },
      },
      requestId: actor.requestId,
    });
    return toBusinessPhoto(after);
  });
}

/** Removes a photo and then its stored images (AC-W8-11). */
export async function removePhoto(
  db: Database,
  actor: Actor,
  photoId: string,
  options: PhotoStorageOptions,
): Promise<void> {
  requirePermission(actor, 'settings.manage');
  const id = BusinessPhotoIdSchema.safeParse(photoId);
  if (!id.success) throw new PhotoNotFoundError();
  const removed = await withMember(db, actor.context, async (tx) => {
    await lockBusinessPhotos(tx);
    const row = await deleteBusinessPhoto(tx, id.data);
    if (row === undefined) throw new PhotoNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'business_photo.removed',
        entity: { type: 'business_photo', id: row.id },
        before: { kind: BusinessPhotoKindSchema.parse(row.kind) },
        after: null,
      },
      requestId: actor.requestId,
    });
    return row;
  });
  await deleteObjects(options, objectKeys(actor.context.tenantId, removed));
}

/**
 * One width of a photo on the booking page at `slug` (AC-W8-12), or `null` when that page has
 * no such photo at that width: the row is read through the page's own business, so one
 * business's page never serves another's photo.
 */
export async function readPagePhoto(
  db: Database,
  slug: TenantSlug,
  photoId: string,
  width: number,
  store: ObjectStore,
): Promise<Uint8Array | null> {
  const parsedSlug = TenantSlugSchema.safeParse(slug);
  const id = BusinessPhotoIdSchema.safeParse(photoId);
  if (!parsedSlug.success || !id.success || !Number.isInteger(width)) return null;
  const key = await withPublicTenant(
    db,
    parsedSlug.data,
    async (tx, tenant) => {
      const row = await findBusinessPhoto(tx, id.data);
      return row?.widths.includes(width) === true ? photoObjectKey(tenant.id, row.id, width) : null;
    },
    { readOnly: true },
  );
  if (key === undefined || key === null) return null;
  const object = await store.get(key);
  return object?.body ?? null;
}

/**
 * Deletes every stored image of the business's photos (S51.2, ADR-0054), the step before the
 * business itself is deleted for good; the rows go with the business. Returns how many images.
 * Throws when they can't be deleted (no store, or the store failed), so the business waits for
 * the next pass rather than leaving its images behind.
 */
export async function deleteAllPhotoImages(
  db: Database,
  tenantId: TenantId,
  store: ObjectStore | null,
): Promise<number> {
  const rows = await withTenant(db, tenantId, listBusinessPhotos);
  const keys = rows.flatMap((row) => objectKeys(tenantId, row));
  if (keys.length === 0) return 0;
  if (store === null) throw new Error('No object store to delete the photos from');
  await store.delete(keys);
  return keys.length;
}
