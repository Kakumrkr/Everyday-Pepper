import { describe, expect, it } from 'vitest';
import { AuditChangeSchema } from './audit.js';
import {
  BusinessPhotosSchema,
  PhotoCaptionInputSchema,
  PhotoUploadQuerySchema,
  photoPath,
  PublicPhotoSchema,
} from './photos.js';

const ID = '0190a0a0-0000-7000-8000-00000000000a';
const photo = { id: ID, widths: [320, 640], width: 900, height: 600, caption: null };

describe('photo contracts (S47.2, ADR-0048)', () => {
  it('takes captions as one trimmed line, empty as none', () => {
    expect(PhotoCaptionInputSchema.parse({ caption: '  Skin fade, low taper  ' })).toEqual({
      caption: 'Skin fade, low taper',
    });
    expect(PhotoCaptionInputSchema.parse({ caption: '   ' })).toEqual({ caption: null });
    expect(PhotoCaptionInputSchema.parse({ caption: null })).toEqual({ caption: null });
    expect(PhotoCaptionInputSchema.safeParse({ caption: 'two\nlines' }).success).toBe(false);
    expect(PhotoCaptionInputSchema.safeParse({ caption: 'x'.repeat(151) }).success).toBe(false);
    expect(PhotoCaptionInputSchema.safeParse({ caption: 'ok', extra: 1 }).success).toBe(false);
  });

  it('knows the three kinds only', () => {
    expect(PhotoUploadQuerySchema.parse({ kind: 'cover' })).toEqual({ kind: 'cover' });
    expect(PhotoUploadQuerySchema.safeParse({ kind: 'avatar' }).success).toBe(false);
  });

  it('holds widths and a gallery of at most 12', () => {
    expect(PublicPhotoSchema.parse(photo)).toEqual(photo);
    expect(PublicPhotoSchema.safeParse({ ...photo, widths: [] }).success).toBe(false);
    expect(PublicPhotoSchema.safeParse({ ...photo, widths: [4000] }).success).toBe(false);
    const gallery = Array.from({ length: 13 }, () => photo);
    expect(BusinessPhotosSchema.safeParse({ logo: null, cover: null, gallery }).success).toBe(
      false,
    );
    expect(
      BusinessPhotosSchema.safeParse({ logo: photo, cover: null, gallery: gallery.slice(1) })
        .success,
    ).toBe(true);
  });

  it('builds the image path, escaping its parts', () => {
    expect(photoPath('juniper-hair', ID, 640)).toBe(
      `/v1/public/businesses/juniper-hair/photos/${ID}/640`,
    );
    expect(photoPath('a/b', ID, 1)).toContain('/a%2Fb/');
  });

  it('audits the kind only, never a caption', () => {
    const entity = { type: 'business_photo', id: ID };
    expect(
      AuditChangeSchema.safeParse({
        action: 'business_photo.added',
        entity,
        before: null,
        after: { kind: 'logo' },
      }).success,
    ).toBe(true);
    expect(
      AuditChangeSchema.safeParse({
        action: 'business_photo.updated',
        entity,
        before: { captioned: false },
        after: { captioned: true, caption: 'Ana’s fade' },
      }).success,
    ).toBe(false);
    expect(
      AuditChangeSchema.safeParse({
        action: 'business_photo.removed',
        entity,
        before: { kind: 'gallery' },
        after: null,
      }).success,
    ).toBe(true);
  });
});
