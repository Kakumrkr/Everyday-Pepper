import {
  BusinessPhotoSchema,
  photoPath,
  type BusinessPhoto,
  type BusinessPhotoKind,
  type PublicPhoto,
} from '@pepper/contracts';
import { messageFor, type CallResult } from './client-api';

// Booking page photos in the browser (S47.2, ADR-0048, AC-W8-10…12): their image URLs on the
// app's own origin, their alt text, and the owner's upload.

/** What the file picker offers; an iPhone hands its HEIC photos over as JPEG for these. */
export const ACCEPTED_PHOTO_TYPES = 'image/jpeg,image/png,image/webp';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** The `srcset` of a photo: each width it was kept at. */
export function photoSrcSet(slug: string, photo: PublicPhoto): string {
  return photo.widths
    .map((width) => `${photoPath(slug, photo.id, width)} ${String(width)}w`)
    .join(', ');
}

/** The URL of the narrowest width at least `px` wide (the widest when none is). */
export function photoSrc(slug: string, photo: PublicPhoto, px: number): string {
  const width = photo.widths.find((w) => w >= px) ?? photo.widths.at(-1) ?? px;
  return photoPath(slug, photo.id, width);
}

/** A photo's alt text (AC-W8-12): its caption, else what it is. */
export function photoAlt(
  photo: PublicPhoto,
  kind: BusinessPhotoKind,
  businessName: string,
): string {
  if (photo.caption !== null) return photo.caption;
  if (kind === 'logo') return `Logo of ${businessName}`;
  if (kind === 'cover') return businessName;
  return `Work at ${businessName}`;
}

/** Why a picked file can't be sent, before sending it; `null` when it may be. */
export function precheckPhoto(file: { size: number; type: string }): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'That photo is over 10 MB. Pick a smaller one.';
  if (/^image\/hei[cf]/i.test(file.type)) {
    return 'HEIC photos are not supported yet. Save it as a JPEG and try again.';
  }
  if (file.type !== '' && !ACCEPTED_PHOTO_TYPES.split(',').includes(file.type)) {
    return 'Use a JPEG, PNG or WebP photo.';
  }
  return null;
}

/**
 * Sends a photo as the request body (`POST /v1/tenant/photos?kind=`); the api checks it by its
 * content and says what to fix when it can't use it.
 */
export async function uploadPhoto(
  kind: BusinessPhotoKind,
  file: Blob,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<BusinessPhoto>> {
  let response: Response;
  try {
    response = await fetch(`/v1/tenant/photos?kind=${kind}`, {
      method: 'POST',
      headers: { 'content-type': file.type === '' ? 'application/octet-stream' : file.type },
      body: file,
      credentials: 'same-origin',
    });
  } catch {
    return { ok: false, status: 0, message: 'You seem to be offline. Check your connection.' };
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // A refused photo's own words say what to fix ("…at least 600 px on its short side").
    const own =
      typeof data === 'object' && data !== null && 'code' in data && data.code === 'photo_rejected'
        ? (data as { message?: unknown }).message
        : undefined;
    return {
      ok: false,
      status: response.status,
      message: typeof own === 'string' ? own : messageFor(response.status, data),
      body: data,
    };
  }
  const parsed = BusinessPhotoSchema.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, message: 'Something went wrong. Try again.' };
}
