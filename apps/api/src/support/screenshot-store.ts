import type { ScreenshotImage, ScreenshotStorage } from '@pepper/core';
import { createScreenshotStore, S3ObjectStore, type StorageConfig } from '@pepper/storage';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import type { ServerResponse } from 'node:http';

// Support screenshots' storage (S59.2.3, ADR-0062 Part 3): core's `ScreenshotStorage` port on the
// object store photos use (ADR-0048; `PhotosModule` makes the bucket). `null` without `S3_*`:
// uploads answer 503 `screenshots_unavailable` and images are not found.

export const SCREENSHOT_STORE = Symbol('SCREENSHOT_STORE');

@Global()
@Module({})
export class ScreenshotStoreModule {
  static forRoot(config: StorageConfig | null): DynamicModule {
    return {
      module: ScreenshotStoreModule,
      providers: [
        {
          provide: SCREENSHOT_STORE,
          useValue: config === null ? null : createScreenshotStore(new S3ObjectStore(config)),
        },
      ],
      exports: [SCREENSHOT_STORE],
    };
  }
}

/** The store, or `null` (none configured, or a test module without it). */
export type ScreenshotStoreOrNone = ScreenshotStorage | null;

/**
 * Sends a screenshot as a private image (AC-X-29): never cached by a browser or a proxy (each
 * read is checked, and an operator's is logged), never sniffed or run as anything but an image.
 */
export function sendScreenshot(response: ServerResponse, image: ScreenshotImage): void {
  const { body } = image;
  response.statusCode = 200;
  response.setHeader('Content-Type', image.contentType);
  response.setHeader('Content-Length', String(body.byteLength));
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Disposition', 'inline');
  response.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
}
