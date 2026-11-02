import 'reflect-metadata';
import { TenantIdSchema, TenantSlugSchema, UserIdSchema } from '@pepper/contracts';
import type { Database } from '@pepper/db';
import { MemoryObjectStore, S3ObjectStore, type StorageConfig } from '@pepper/storage';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OBJECT_STORE, PhotosService } from './photos.service.js';
import { PhotosModule } from './photos.module.js';

const appointments = vi.hoisted(() => ({
  listPhotos: vi.fn(() => Promise.resolve('listed')),
  addPhoto: vi.fn(() => Promise.resolve('added')),
  changePhotoCaption: vi.fn(() => Promise.resolve('captioned')),
  removePhoto: vi.fn(() => Promise.resolve()),
  readPagePhoto: vi.fn(() => Promise.resolve(new Uint8Array([1]))),
}));
vi.mock('@pepper/appointments', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...appointments,
}));

const db = {} as Database;
const tenant = {
  tenantId: TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192'),
  userId: UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193'),
  role: 'owner' as const,
};
const actor = { context: tenant, requestId: undefined };
const slug = TenantSlugSchema.parse('juniper');
const id = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PhotosService (ADR-0048)', () => {
  it('binds the database, the store and the member to each photo service', async () => {
    const store = new MemoryObjectStore();
    const service = new PhotosService({ db }, store);
    const bytes = new Uint8Array([9]);
    expect(await service.list(tenant)).toBe('listed');
    expect(await service.add(tenant, 'logo', bytes)).toBe('added');
    expect(await service.caption(tenant, id, 'Fade')).toBe('captioned');
    await service.remove(tenant, id);
    expect(await service.image(slug, id, 640)).toEqual(new Uint8Array([1]));
    expect(appointments.listPhotos).toHaveBeenCalledWith(db, actor);
    expect(appointments.addPhoto).toHaveBeenCalledWith(
      db,
      actor,
      { kind: 'logo', bytes },
      expect.objectContaining({ store }),
    );
    expect(appointments.changePhotoCaption).toHaveBeenCalledWith(db, actor, id, 'Fade');
    expect(appointments.removePhoto).toHaveBeenCalledWith(
      db,
      actor,
      id,
      expect.objectContaining({ store }),
    );
    expect(appointments.readPagePhoto).toHaveBeenCalledWith(db, slug, id, 640, store);
  });

  it('logs a failed clean-up with the error only', () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new PhotosService({ db }, new MemoryObjectStore())
      .storage()
      .onCleanupError?.(new Error('store down'));
    expect(warn).toHaveBeenCalledWith(
      'Stored photo images could not be deleted: Error: store down',
    );
    warn.mockRestore();
  });

  it('without a store: 503 storage_unavailable for owners, no image for the page', async () => {
    const service = new PhotosService({ db }, null);
    expect(() => service.storage()).toThrow(ServiceUnavailableException);
    expect(() => service.add(tenant, 'logo', new Uint8Array())).toThrow(
      ServiceUnavailableException,
    );
    expect(await service.image(slug, id, 640)).toBeNull();
    expect(appointments.readPagePhoto).not.toHaveBeenCalled();
    service.onApplicationShutdown();
  });

  it('closes an S3 store when the app stops', () => {
    const store = Object.create(S3ObjectStore.prototype) as S3ObjectStore;
    const close = vi.spyOn(store, 'close').mockImplementation(() => undefined);
    new PhotosService({ db }, store).onApplicationShutdown();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('PhotosModule.forRoot', () => {
  const config: StorageConfig = {
    endpoint: 'http://127.0.0.1:1',
    region: 'us-east-1',
    bucket: 'pepper-test',
    accessKeyId: 'test',
    secretAccessKey: 'test-secret',
  };

  async function storeOf(storage: StorageConfig | null): Promise<unknown> {
    const moduleRef = await Test.createTestingModule({
      providers: (PhotosModule.forRoot(storage).providers ?? []).filter(
        (provider) => typeof provider === 'object' && provider.provide === OBJECT_STORE,
      ),
    }).compile();
    return moduleRef.get(OBJECT_STORE);
  }

  it('has no store without storage settings', async () => {
    expect(await storeOf(null)).toBeNull();
  });

  it('makes the bucket on start, and keeps the store (logged) when that fails', async () => {
    const ensure = vi
      .spyOn(S3ObjectStore.prototype, 'ensureBucket')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('unreachable'));
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const stores = [await storeOf(config), await storeOf(config)];
    for (const store of stores) {
      expect(store).toBeInstanceOf(S3ObjectStore);
      (store as S3ObjectStore).close();
    }
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith('Object storage is not reachable: Error: unreachable');
    ensure.mockRestore();
    error.mockRestore();
  });
});
