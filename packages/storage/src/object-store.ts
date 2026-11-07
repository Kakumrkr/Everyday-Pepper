/**
 * Object storage (ADR-0048): a provider-neutral port. The S3 adapter talks to SeaweedFS in
 * development and CI (ADR-0011) and to R2 or S3 in the pilot; tests use the in-memory store.
 */
export interface ObjectStore {
  /** Stores `body` at `key`, replacing what was there. */
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** The object at `key`, or `null` when there is none. */
  get(key: string): Promise<StoredObject | null>;
  /** The object's size and type without its body, or `null` when there is none. */
  head(key: string): Promise<ObjectInfo | null>;
  /** Deletes the objects at `keys`; a key with no object is not an error. */
  delete(keys: readonly string[]): Promise<void>;
}

export interface ObjectInfo {
  size: number;
  contentType: string;
}

export interface StoredObject extends ObjectInfo {
  body: Uint8Array;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where one width of a business's photo is kept: `tenants/<tenant>/photos/<photo>/<width>.webp`.
 * The tenant id comes from the session (never from a request), and both ids must be UUIDs, so
 * no input can reach another business's prefix.
 */
export function photoObjectKey(tenantId: string, photoId: string, width: number): string {
  if (!UUID.test(tenantId) || !UUID.test(photoId)) throw new Error('Invalid photo key ids');
  if (!Number.isInteger(width) || width < 1 || width > 4096) throw new Error('Invalid width');
  return `tenants/${tenantId}/photos/${photoId}/${String(width)}.webp`;
}

/**
 * Where one width of a support screenshot is kept (ADR-0062 Part 3):
 * `tenants/<tenant>/support/<screenshot>/<width>.webp`, under the same rules as photos.
 */
export function screenshotObjectKey(tenantId: string, screenshotId: string, width: number): string {
  if (!UUID.test(tenantId) || !UUID.test(screenshotId))
    throw new Error('Invalid screenshot key ids');
  if (!Number.isInteger(width) || width < 1 || width > 4096) throw new Error('Invalid width');
  return `tenants/${tenantId}/support/${screenshotId}/${String(width)}.webp`;
}

/** An `ObjectStore` in memory, for unit tests and tools; never for the running app. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { body: Uint8Array.from(body), size: body.byteLength, contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { ...found, body: Uint8Array.from(found.body) },
    );
  }

  head(key: string): Promise<ObjectInfo | null> {
    const found = this.objects.get(key);
    return Promise.resolve(
      found === undefined ? null : { size: found.size, contentType: found.contentType },
    );
  }

  delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
    return Promise.resolve();
  }

  /** The keys held, sorted (for tests). */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
