import { PublicPhotoSchema } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { photoAlt, photoSrc, photoSrcSet, precheckPhoto, uploadPhoto } from './photos';

const ID = '0190a0a0-0000-7000-8000-00000000000a';
const photo = PublicPhotoSchema.parse({
  id: ID,
  widths: [320, 640, 1280],
  width: 2000,
  height: 1500,
  caption: null,
});

describe('photo URLs and alt text (AC-W8-12)', () => {
  it('lists each kept width on the app’s origin', () => {
    expect(photoSrcSet('fade-lab', photo)).toBe(
      `/v1/public/businesses/fade-lab/photos/${ID}/320 320w, /v1/public/businesses/fade-lab/photos/${ID}/640 640w, /v1/public/businesses/fade-lab/photos/${ID}/1280 1280w`,
    );
    expect(photoSrc('fade-lab', photo, 500)).toMatch(/\/640$/);
    expect(photoSrc('fade-lab', photo, 4000)).toMatch(/\/1280$/);
  });

  it('uses the caption, else says what the photo is', () => {
    expect(photoAlt({ ...photo, caption: 'Low taper' }, 'gallery', 'Fade Lab')).toBe('Low taper');
    expect(photoAlt(photo, 'logo', 'Fade Lab')).toBe('Logo of Fade Lab');
    expect(photoAlt(photo, 'cover', 'Fade Lab')).toBe('Fade Lab');
    expect(photoAlt(photo, 'gallery', 'Fade Lab')).toBe('Work at Fade Lab');
  });
});

describe('precheckPhoto', () => {
  it('stops what the api would refuse anyway, before sending it', () => {
    expect(precheckPhoto({ size: 11 * 1024 * 1024, type: 'image/jpeg' })).toContain('10 MB');
    expect(precheckPhoto({ size: 10, type: 'image/heic' })).toContain('HEIC');
    expect(precheckPhoto({ size: 10, type: 'image/gif' })).toContain('JPEG, PNG or WebP');
    expect(precheckPhoto({ size: 10, type: 'image/png' })).toBeNull();
    // No type from the picker: the api decides by content.
    expect(precheckPhoto({ size: 10, type: '' })).toBeNull();
  });
});

describe('uploadPhoto', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(() => Promise.resolve(Response.json(body, { status }))) as unknown as typeof fetch;

  it('sends the file itself with its type and reads the photo back', async () => {
    const fetch = answer(201, {
      ...photo,
      kind: 'cover',
      createdAt: '2026-11-02T10:00:00.000Z',
    });
    const file = new Blob([new Uint8Array([1, 2])], { type: 'image/jpeg' });
    const result = await uploadPhoto('cover', file, fetch);
    expect(result).toMatchObject({ ok: true, data: { id: ID, kind: 'cover' } });
    expect(fetch).toHaveBeenCalledWith('/v1/tenant/photos?kind=cover', {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: file,
      credentials: 'same-origin',
    });
  });

  it('shows a refused photo’s own words, and other refusals’ usual ones', async () => {
    const small = await uploadPhoto(
      'cover',
      new Blob(['x']),
      answer(422, {
        code: 'photo_rejected',
        message: 'That photo is too small. Use one at least 600 px on its short side.',
      }),
    );
    expect(small).toMatchObject({ ok: false, status: 422 });
    expect(small.ok ? '' : small.message).toContain('600 px');
    const full = await uploadPhoto(
      'gallery',
      new Blob(['x']),
      answer(409, { code: 'gallery_full' }),
    );
    expect(full.ok ? '' : full.message).toContain('12 photos');
    const offline = await uploadPhoto(
      'logo',
      new Blob(['x']),
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    expect(offline).toMatchObject({ ok: false, status: 0 });
    const odd = await uploadPhoto('logo', new Blob(['x']), answer(201, { nope: true }));
    expect(odd).toMatchObject({ ok: false, message: 'Something went wrong. Try again.' });
  });
});
