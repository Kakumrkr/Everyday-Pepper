import { startSeaweedFs, type TestObjectStorage } from '@pepper/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StorageConfig } from './config.js';
import { photoObjectKey } from './object-store.js';
import { S3ObjectStore } from './s3.js';

// The contract test ADR-0011 asks for: exactly the S3 calls the app makes, against SeaweedFS.
let storage: TestObjectStorage;
let config: StorageConfig;
let store: S3ObjectStore;

const TENANT = '0190a0a0-0000-7000-8000-000000000001';
const PHOTO = '0190a0a0-0000-7000-8000-000000000002';

beforeAll(async () => {
  storage = await startSeaweedFs();
  config = {
    endpoint: storage.endpoint,
    region: 'us-east-1',
    bucket: 'pepper-test',
    accessKeyId: storage.accessKeyId,
    secretAccessKey: storage.secretAccessKey,
  };
  store = new S3ObjectStore(config);
  await store.ensureBucket();
});

afterAll(async () => {
  store.close();
  await storage.stop();
});

describe('S3ObjectStore against SeaweedFS (ADR-0048)', () => {
  it('makes the bucket once; a second call finds it', async () => {
    await expect(store.ensureBucket()).resolves.toBeUndefined();
  });

  it('puts, reads, heads and deletes an object', async () => {
    const key = photoObjectKey(TENANT, PHOTO, 640);
    const body = Uint8Array.from({ length: 70_000 }, (_, i) => i % 251);
    await store.put(key, body, 'image/webp');
    const read = await store.get(key);
    expect(read?.contentType).toBe('image/webp');
    expect(read?.size).toBe(body.byteLength);
    expect(Buffer.from(read?.body ?? []).equals(Buffer.from(body))).toBe(true);
    expect(await store.head(key)).toEqual({ size: body.byteLength, contentType: 'image/webp' });
    await store.delete([key, photoObjectKey(TENANT, PHOTO, 1280)]);
    expect(await store.get(key)).toBeNull();
    expect(await store.head(key)).toBeNull();
  });

  it('replaces an object put again at the same key', async () => {
    const key = photoObjectKey(TENANT, PHOTO, 320);
    await store.put(key, Uint8Array.from([1]), 'image/webp');
    await store.put(key, Uint8Array.from([2, 3]), 'image/webp');
    expect(Array.from((await store.get(key))?.body ?? [])).toEqual([2, 3]);
  });

  it('answers null for a key that was never written', async () => {
    expect(await store.get('tenants/none/photos/none/1.webp')).toBeNull();
    expect(await store.head('tenants/none/photos/none/1.webp')).toBeNull();
  });

  it('refuses requests signed with other keys', async () => {
    const stranger = new S3ObjectStore({ ...config, secretAccessKey: 'not-the-secret-key' });
    await expect(stranger.get(photoObjectKey(TENANT, PHOTO, 320))).rejects.toThrow();
    stranger.close();
  });
});
