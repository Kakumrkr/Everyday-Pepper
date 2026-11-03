import { MAX_PHOTO_WIDTH, TenantSlugSchema } from '@pepper/contracts';
import type { ServerResponse } from 'node:http';
import { Controller, Get, NotFoundException, Param, Req, Res } from '@nestjs/common';
import { z } from 'zod';
import { apiError } from '../auth/guards.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { PhotosService } from './photos.service.js';

// A page shows up to 14 images, each at the width the screen needs: generous for people.
const IMAGE_READS: RateLimit = { name: 'photo-read', max: 600, windowSeconds: 60 };

const ImageParamsSchema = z.object({
  slug: z.string(),
  photoId: z.string(),
  width: z.coerce.number().int().min(1).max(MAX_PHOTO_WIDTH),
});

type IncomingRequest = Parameters<typeof clientAddress>[0];

/**
 * A booking page photo at one width (S47.2, ADR-0048, AC-W8-12), from the app's own origin.
 * A photo id never changes its bytes, so the answer is cached as immutable; nothing else on
 * the page is. Not found (404 `photo_not_found`) for an unknown page, photo or width, a
 * malformed id, another business's photo, or when storage is off.
 */
@Controller('v1/public/businesses/:slug/photos')
export class PublicPhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly limits: RateLimiter,
  ) {}

  @Get(':photoId/:width')
  async image(
    @Param() params: unknown,
    @Req() request: IncomingRequest,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const parsed = ImageParamsSchema.safeParse(params);
    const slug = TenantSlugSchema.safeParse(parsed.data?.slug);
    if (!parsed.success || !slug.success) throw new NotFoundException(apiError('photo_not_found'));
    await this.limits.hit(IMAGE_READS, clientAddress(request));
    const body = await this.photos.image(slug.data, parsed.data.photoId, parsed.data.width);
    if (body === null) throw new NotFoundException(apiError('photo_not_found'));
    response.statusCode = 200;
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Content-Length', String(body.byteLength));
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.end(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
}
