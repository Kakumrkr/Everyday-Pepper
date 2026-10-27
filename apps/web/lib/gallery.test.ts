import { describe, expect, it } from 'vitest';
import { galleryEnabled } from './gallery';

describe('galleryEnabled', () => {
  it('is on only with PEPPER_GALLERY=1', () => {
    expect(galleryEnabled({ PEPPER_GALLERY: '1' })).toBe(true);
  });

  it.each([{}, { PEPPER_GALLERY: '' }, { PEPPER_GALLERY: '0' }, { PEPPER_GALLERY: 'true' }])(
    'is off for %j',
    (env) => {
      expect(galleryEnabled(env)).toBe(false);
    },
  );
});
