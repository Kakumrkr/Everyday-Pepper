import { S3ObjectStore, type StorageConfig } from '@pepper/storage';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { PhotosController } from './photos.controller.js';
import { OBJECT_STORE, PhotosService } from './photos.service.js';
import { PublicPhotosController } from './public-photos.controller.js';

/**
 * Booking page photos (S47.2, ADR-0048): the owner's endpoints and the page's images. Makes
 * the bucket on start when it is missing (development and CI); a failure there is logged and
 * uploads fail until the store answers. Needs `ConnectionsModule` and `AuthModule`.
 */
@Module({})
export class PhotosModule {
  static forRoot(config: StorageConfig | null): DynamicModule {
    return {
      module: PhotosModule,
      controllers: [PhotosController, PublicPhotosController],
      providers: [
        {
          provide: OBJECT_STORE,
          useFactory: async () => {
            if (config === null) return null;
            const store = new S3ObjectStore(config);
            try {
              await store.ensureBucket();
            } catch (error) {
              new Logger(PhotosModule.name).error(
                `Object storage is not reachable: ${String(error)}`,
              );
            }
            return store;
          },
        },
        PhotosService,
        RateLimiter,
      ],
    };
  }
}
