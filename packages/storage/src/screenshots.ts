import { ImageRejectedError, processImage } from './images.js';
import { screenshotObjectKey, type ObjectStore } from './object-store.js';

/** What checking an upload gave: the remade screenshot, or why it was refused. */
export type ScreenshotProcessing =
  | {
      kind: 'image';
      width: number;
      height: number;
      /** WebP without metadata, narrowest first. */
      variants: { width: number; data: Uint8Array }[];
    }
  | { kind: 'rejected'; reason: string; message: string };

/**
 * Support screenshots on an object store (S59.2.3, ADR-0062 Part 3): the adapter for core's
 * `ScreenshotStorage` port, which may not depend on this package (layer rules). Keys are
 * `tenants/<t>/support/<id>/<width>.webp`; the tenant id always comes from the caller's session.
 */
export interface ScreenshotStore {
  process(bytes: Uint8Array): Promise<ScreenshotProcessing>;
  put(tenantId: string, id: string, width: number, data: Uint8Array): Promise<void>;
  /** The image, or `null` when there is none. */
  get(tenantId: string, id: string, width: number): Promise<Uint8Array | null>;
  /** Deletes the widths of each screenshot; a missing one is not an error. */
  delete(
    screenshots: readonly { tenantId: string; id: string; widths: readonly number[] }[],
  ): Promise<void>;
}

const WEBP = 'image/webp';

export function createScreenshotStore(store: ObjectStore): ScreenshotStore {
  return {
    async process(bytes) {
      try {
        const image = await processImage(bytes, 'screenshot');
        return {
          kind: 'image',
          width: image.width,
          height: image.height,
          variants: image.variants.map(({ width, data }) => ({ width, data })),
        };
      } catch (error) {
        if (error instanceof ImageRejectedError) {
          return { kind: 'rejected', reason: error.reason, message: error.message };
        }
        throw error;
      }
    },
    async put(tenantId, id, width, data) {
      await store.put(screenshotObjectKey(tenantId, id, width), data, WEBP);
    },
    async get(tenantId, id, width) {
      return (await store.get(screenshotObjectKey(tenantId, id, width)))?.body ?? null;
    },
    async delete(screenshots) {
      const keys = screenshots.flatMap(({ tenantId, id, widths }) =>
        widths.map((width) => screenshotObjectKey(tenantId, id, width)),
      );
      if (keys.length > 0) await store.delete(keys);
    },
  };
}
