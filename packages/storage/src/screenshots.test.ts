import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { solidColorPhoto } from './images.js';
import { MemoryObjectStore } from './object-store.js';
import { createScreenshotStore } from './screenshots.js';

const TENANT = '0190a0a0-0000-7000-8000-000000000001';
const SHOT = '0190a0a0-0000-7000-8000-000000000003';

describe('createScreenshotStore (S59.2.3, AC-X-28)', () => {
  it('remakes an upload, keeps each width under the business’s support prefix and deletes them', async () => {
    const memory = new MemoryObjectStore();
    const store = createScreenshotStore(memory);
    const processed = await store.process(await solidColorPhoto(1170, 2532, 'png'));
    if (processed.kind !== 'image') throw new Error('refused');
    expect(processed.variants.map((v) => v.width)).toEqual([480, 1170]);
    for (const variant of processed.variants) {
      await store.put(TENANT, SHOT, variant.width, variant.data);
    }
    expect(memory.keys().sort()).toEqual([
      `tenants/${TENANT}/support/${SHOT}/1170.webp`,
      `tenants/${TENANT}/support/${SHOT}/480.webp`,
    ]);
    const thumb = await store.get(TENANT, SHOT, 480);
    expect((await sharp(thumb ?? undefined).metadata()).format).toBe('webp');
    expect(await store.get(TENANT, SHOT, 2560)).toBeNull();
    await store.delete([{ tenantId: TENANT, id: SHOT, widths: [480, 1170] }]);
    await store.delete([]);
    expect(memory.keys()).toEqual([]);
  });

  it('answers a refusal with its reason and words, never throws it', async () => {
    const store = createScreenshotStore(new MemoryObjectStore());
    expect(await store.process(Buffer.from('not an image'))).toEqual({
      kind: 'rejected',
      reason: 'unreadable',
      message: 'That file is not a screenshot we can read. Use a JPEG, PNG or WebP screenshot.',
    });
  });

  it('refuses keys outside a business’s prefix', async () => {
    const store = createScreenshotStore(new MemoryObjectStore());
    await expect(store.put('../x', SHOT, 480, new Uint8Array(1))).rejects.toThrow(
      'Invalid screenshot key ids',
    );
  });
});
