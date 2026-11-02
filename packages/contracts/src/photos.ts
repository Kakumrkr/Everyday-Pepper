import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

// A business's photos on its booking page (S47.2, ADR-0048, AC-W8-10…12): one logo, one cover
// and a gallery of its work. The files themselves are checked and remade by `@pepper/storage`;
// these are the rows and answers about them.

export const BUSINESS_PHOTO_KINDS = ['logo', 'cover', 'gallery'] as const;
export const BusinessPhotoKindSchema = z.enum(BUSINESS_PHOTO_KINDS);
export type BusinessPhotoKind = z.infer<typeof BusinessPhotoKindSchema>;

/** A photo's id: a lowercased UUID, new for every upload (so its images never change). */
export const BusinessPhotoIdSchema = z.uuid().toLowerCase().brand<'BusinessPhotoId'>();
export type BusinessPhotoId = z.infer<typeof BusinessPhotoIdSchema>;

/** The most gallery photos a business keeps (D-5). */
export const MAX_GALLERY_PHOTOS = 12;
/** The longest caption (it is the photo's alt text). */
export const MAX_PHOTO_CAPTION_LENGTH = 150;
/** The widest image kept for any kind. */
export const MAX_PHOTO_WIDTH = 1920;

/** A caption: one line of plain text, trimmed; empty means none. */
export const PhotoCaptionSchema = z
  .string()
  .trim()
  .max(MAX_PHOTO_CAPTION_LENGTH)
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'Use one line of plain text')
  .transform((value) => (value === '' ? null : value));

const WidthsSchema = z.array(z.number().int().min(1).max(MAX_PHOTO_WIDTH)).min(1).max(3);

/** A photo as the booking page shows it: the widths it can be fetched at, and its caption. */
export const PublicPhotoSchema = z
  .object({
    id: BusinessPhotoIdSchema,
    /** Narrowest first; `…/photos/<id>/<width>` serves each. */
    widths: WidthsSchema,
    /** The upright original's size, for the aspect ratio. */
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    caption: z.string().max(MAX_PHOTO_CAPTION_LENGTH).nullable(),
  })
  .strict();
export type PublicPhoto = z.infer<typeof PublicPhotoSchema>;

/** `PublicBusiness.photos` and `GET /v1/tenant/photos`. Gallery oldest first. */
export const BusinessPhotosSchema = z
  .object({
    logo: PublicPhotoSchema.nullable(),
    cover: PublicPhotoSchema.nullable(),
    gallery: z.array(PublicPhotoSchema).max(MAX_GALLERY_PHOTOS),
  })
  .strict();
export type BusinessPhotos = z.infer<typeof BusinessPhotosSchema>;

export const NO_PHOTOS: BusinessPhotos = { logo: null, cover: null, gallery: [] };

/** A stored photo, as the owner's screen and the services see it. */
export const BusinessPhotoSchema = PublicPhotoSchema.extend({
  kind: BusinessPhotoKindSchema,
  createdAt: UtcDateTimeSchema,
}).strict();
export type BusinessPhoto = z.infer<typeof BusinessPhotoSchema>;

/** `POST /v1/tenant/photos?kind=…` (the image is the body). */
export const PhotoUploadQuerySchema = z.object({ kind: BusinessPhotoKindSchema }).strict();

/** `PATCH /v1/tenant/photos/:id`. */
export const PhotoCaptionInputSchema = z
  .object({ caption: PhotoCaptionSchema.nullable() })
  .strict();
export type PhotoCaptionInput = z.input<typeof PhotoCaptionInputSchema>;

/** `/v1/public/businesses/:slug/photos/:id/:width` and the owner's own image URL. */
export function photoPath(slug: string, id: string, width: number): string {
  return `/v1/public/businesses/${encodeURIComponent(slug)}/photos/${encodeURIComponent(id)}/${String(width)}`;
}
