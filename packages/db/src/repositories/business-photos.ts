import {
  BusinessPhotoKindSchema,
  MAX_PHOTO_CAPTION_LENGTH,
  type BusinessPhotoKind,
} from '@pepper/contracts';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { businessPhotos, type BusinessPhotoRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// A business's booking page photos (S47.2, ADR-0048). Every query runs in the business's own
// transaction, so RLS keeps each business to its own rows.

export interface NewBusinessPhoto {
  /** Made by the caller before the images are stored under it. */
  id: string;
  kind: BusinessPhotoKind;
  widths: readonly number[];
  width: number;
  height: number;
  caption: string | null;
}

/** Inserts a photo row (its images are already stored). */
export async function insertBusinessPhoto(
  tx: TenantTx,
  photo: NewBusinessPhoto,
): Promise<BusinessPhotoRow> {
  const kind = BusinessPhotoKindSchema.parse(photo.kind);
  if (photo.caption !== null && photo.caption.length > MAX_PHOTO_CAPTION_LENGTH) {
    throw new Error('Caption too long');
  }
  const [row] = await tx
    .insert(businessPhotos)
    .values({ ...photo, kind, widths: [...photo.widths] })
    .returning();
  if (row === undefined) throw new Error('Insert returned no row');
  return row;
}

/** The business's photos, oldest first. */
export function listBusinessPhotos(tx: TenantTx): Promise<BusinessPhotoRow[]> {
  return tx
    .select()
    .from(businessPhotos)
    .where(eq(businessPhotos.tenantId, sql`current_tenant_id()`))
    .orderBy(asc(businessPhotos.createdAt), asc(businessPhotos.id));
}

/** One of the business's photos, or `undefined`. */
export async function findBusinessPhoto(
  tx: TenantTx,
  id: string,
): Promise<BusinessPhotoRow | undefined> {
  const [row] = await tx.select().from(businessPhotos).where(eq(businessPhotos.id, id));
  return row;
}

/** How many photos of `kind` the business has. */
export async function countBusinessPhotos(tx: TenantTx, kind: BusinessPhotoKind): Promise<number> {
  const [row] = await tx
    .select({ photos: count() })
    .from(businessPhotos)
    .where(
      and(eq(businessPhotos.tenantId, sql`current_tenant_id()`), eq(businessPhotos.kind, kind)),
    );
  return row?.photos ?? 0;
}

/**
 * Holds the business's photo lock until the transaction ends, so two uploads can't both pass
 * the gallery's limit or both replace the logo.
 */
export async function lockBusinessPhotos(tx: TenantTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('business_photos'), hashtext(current_tenant_id()::text))`,
  );
}

/** Sets a photo's caption; the row, or `undefined` when there is none. */
export async function updateBusinessPhotoCaption(
  tx: TenantTx,
  id: string,
  caption: string | null,
): Promise<BusinessPhotoRow | undefined> {
  const [row] = await tx
    .update(businessPhotos)
    .set({ caption })
    .where(eq(businessPhotos.id, id))
    .returning();
  return row;
}

/** Deletes a photo row; the row deleted, or `undefined`. */
export async function deleteBusinessPhoto(
  tx: TenantTx,
  id: string,
): Promise<BusinessPhotoRow | undefined> {
  const [row] = await tx.delete(businessPhotos).where(eq(businessPhotos.id, id)).returning();
  return row;
}

/** Deletes the business's photos of `kind` (a logo or cover being replaced); the rows deleted. */
export function deleteBusinessPhotosOfKind(
  tx: TenantTx,
  kind: BusinessPhotoKind,
): Promise<BusinessPhotoRow[]> {
  return tx
    .delete(businessPhotos)
    .where(
      and(eq(businessPhotos.tenantId, sql`current_tenant_id()`), eq(businessPhotos.kind, kind)),
    )
    .returning();
}
