import { describe, expect, it } from 'vitest';
import { MemoryObjectStore, photoObjectKey, screenshotObjectKey } from './object-store.js';

const TENANT = '0190a0a0-0000-7000-8000-000000000001';
const PHOTO = '0190a0a0-0000-7000-8000-000000000002';

describe('photoObjectKey', () => {
  it('puts each width under the tenant’s own prefix', () => {
    expect(photoObjectKey(TENANT, PHOTO, 640)).toBe(`tenants/${TENANT}/photos/${PHOTO}/640.webp`);
  });

  it('refuses ids that are not UUIDs and odd widths', () => {
    expect(() => photoObjectKey('../other', PHOTO, 640)).toThrow('Invalid photo key ids');
    expect(() => photoObjectKey(TENANT, `${PHOTO}/..`, 640)).toThrow('Invalid photo key ids');
    expect(() => photoObjectKey(TENANT, PHOTO, 0)).toThrow('Invalid width');
    expect(() => photoObjectKey(TENANT, PHOTO, 1.5)).toThrow('Invalid width');
  });
});

describe('screenshotObjectKey', () => {
  it('puts each width under the tenant’s support prefix, refusing odd ids and widths', () => {
    expect(screenshotObjectKey(TENANT, PHOTO, 480)).toBe(
      `tenants/${TENANT}/support/${PHOTO}/480.webp`,
    );
    expect(() => screenshotObjectKey('../other', PHOTO, 480)).toThrow('Invalid screenshot key ids');
    expect(() => screenshotObjectKey(TENANT, PHOTO, 5000)).toThrow('Invalid width');
  });
});

describe('MemoryObjectStore', () => {
  it('puts, reads, heads and deletes copies', async () => {
    const store = new MemoryObjectStore();
    const body = Uint8Array.from([1, 2, 3]);
    await store.put('a', body, 'image/webp');
    body[0] = 9;
    expect(await store.get('a')).toEqual({
      body: Uint8Array.from([1, 2, 3]),
      size: 3,
      contentType: 'image/webp',
    });
    expect(await store.head('a')).toEqual({ size: 3, contentType: 'image/webp' });
    expect(store.keys()).toEqual(['a']);
    await store.delete(['a', 'missing']);
    expect(await store.get('a')).toBeNull();
    expect(await store.head('a')).toBeNull();
  });
});
