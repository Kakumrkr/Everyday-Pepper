import {
  PhotoCaptionInputSchema,
  PhotoUploadQuerySchema,
  type BusinessPhoto,
  type BusinessPhotos,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { MAX_PHOTO_BYTES } from '@pepper/storage';
import type { IncomingMessage } from 'node:http';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { readUpload } from '../http/raw-body.js';
import { parseBody } from '../http/zod-body.js';
import { PhotosService } from './photos.service.js';

// An owner adds a handful of photos; a script resizing images on the api is stopped.
const UPLOADS: RateLimit = { name: 'photo-upload', max: 30, windowSeconds: 600 };

// A malformed id is "not found", like an id of another business.
const PhotoParamsSchema = z.object({ photoId: z.string() });

/**
 * The booking page's photos, `/v1/tenant/photos` (S47.2, ADR-0048, AC-W8-10/11): owners and
 * managers (`settings.manage`). An upload is the image itself as the body (at most 10 MB),
 * with its kind in the query; it is checked by content and remade on the server.
 */
@Controller('v1/tenant/photos')
@UseGuards(TenantGuard)
@RequirePermission('settings.manage')
export class PhotosController {
  constructor(
    private readonly photos: PhotosService,
    private readonly limits: RateLimiter,
  ) {}

  @Get()
  list(@CurrentTenant() tenant: TenantContext): Promise<BusinessPhotos> {
    return answering(() => this.photos.list(tenant));
  }

  /**
   * 201 the photo. 413 `photo_too_large`; 415/422 `photo_rejected` with what to fix; 409
   * `gallery_full`; 429 `too_many_requests`; 503 `storage_unavailable`.
   */
  @Post()
  async add(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
    @Req() request: IncomingMessage,
  ): Promise<BusinessPhoto> {
    const { kind } = parseBody(PhotoUploadQuerySchema, query);
    // Before reading the body: without storage there is nowhere to put it.
    this.photos.storage();
    await this.limits.hit(UPLOADS, tenant.userId);
    const bytes = await readUpload(request, MAX_PHOTO_BYTES);
    return answering(() => this.photos.add(tenant, kind, bytes));
  }

  /** 200 the photo with its caption (its alt text); 404 `photo_not_found`. */
  @Patch(':photoId')
  caption(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<BusinessPhoto> {
    const { photoId } = parseBody(PhotoParamsSchema, params);
    const { caption } = parseBody(PhotoCaptionInputSchema, body);
    return answering(() => this.photos.caption(tenant, photoId, caption));
  }

  /** 204; its images are deleted after. 404 `photo_not_found`. */
  @Delete(':photoId')
  @HttpCode(204)
  async remove(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { photoId } = parseBody(PhotoParamsSchema, params);
    await answering(() => this.photos.remove(tenant, photoId));
  }
}
