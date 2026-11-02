import {
  addPhoto,
  changePhotoCaption,
  listPhotos,
  readPagePhoto,
  removePhoto,
  type PhotoStorageOptions,
} from '@pepper/appointments';
import type {
  BusinessPhoto,
  BusinessPhotoKind,
  BusinessPhotos,
  TenantSlug,
} from '@pepper/contracts';
import type { Actor, TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { S3ObjectStore, type ObjectStore } from '@pepper/storage';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { apiError } from '../auth/guards.js';

/** The object store for photos (ADR-0048); `null` when no `S3_*` is configured. */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/**
 * The booking page's photo services for a request: binds the database, the object store and
 * the request id. Without a store, owners get 503 `storage_unavailable` and the page's images
 * are not found.
 */
@Injectable()
export class PhotosService implements OnApplicationShutdown {
  private readonly db: Database;
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(OBJECT_STORE) private readonly store: ObjectStore | null,
  ) {
    this.db = database.db;
  }

  list(tenant: TenantContext): Promise<BusinessPhotos> {
    return listPhotos(this.db, actorOf(tenant));
  }

  add(tenant: TenantContext, kind: BusinessPhotoKind, bytes: Uint8Array): Promise<BusinessPhoto> {
    return addPhoto(this.db, actorOf(tenant), { kind, bytes }, this.storage());
  }

  caption(tenant: TenantContext, id: string, caption: string | null): Promise<BusinessPhoto> {
    return changePhotoCaption(this.db, actorOf(tenant), id, caption);
  }

  remove(tenant: TenantContext, id: string): Promise<void> {
    return removePhoto(this.db, actorOf(tenant), id, this.storage());
  }

  /** One width of a page's photo, or `null` (no store, page, photo or width). */
  async image(slug: TenantSlug, id: string, width: number): Promise<Uint8Array | null> {
    if (this.store === null) return null;
    return readPagePhoto(this.db, slug, id, width, this.store);
  }

  /** Closes the store's connections when the app stops. */
  onApplicationShutdown(): void {
    if (this.store instanceof S3ObjectStore) this.store.close();
  }

  /** The store and its clean-up report; 503 `storage_unavailable` without one. */
  storage(): PhotoStorageOptions {
    const store = this.store;
    if (store === null) throw new ServiceUnavailableException(apiError('storage_unavailable'));
    return {
      store,
      // Never the key's ids in a message the owner sees; the log has the error only.
      onCleanupError: (error) => {
        this.logger.warn(`Stored photo images could not be deleted: ${String(error)}`);
      },
    };
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
