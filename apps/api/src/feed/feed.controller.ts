import {
  FeedCloseManySchema,
  FeedCloseSchema,
  FeedItemIdSchema,
  FeedResponseSchema,
  FeedSettingsChangeSchema,
  FeedSettingsSchema,
  type FeedResponse,
  type FeedSettings,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { FeedService } from './feed.service.js';

const FeedItemParamsSchema = z.object({ itemId: FeedItemIdSchema });

/**
 * The operator feed, `/v1/feed` (Phase 8, ADR-0039): the open suggestions the insights pass
 * found, for every member (staff only the items addressed to them, by the database's member
 * scope, so another's item is simply not found), and the business's switches, which owners and
 * managers change. Answers are parsed on the way out, so nothing but ids, numbers and the
 * names the member may see leaves.
 */
@Controller('v1/feed')
@UseGuards(TenantGuard)
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get()
  @RequirePermission('feed.read')
  async get(@CurrentTenant() tenant: TenantContext): Promise<FeedResponse> {
    return FeedResponseSchema.parse(await answering(() => this.feed.get(tenant)));
  }

  /**
   * A grouped card's items at once ("Dismiss all", S52): one moment, one dismissal. 204; 404
   * `feed_item_not_found` when none of them is open and the member's.
   */
  @Post('close')
  @HttpCode(204)
  @RequirePermission('feed.read')
  async closeMany(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<void> {
    const close = parseBody(FeedCloseManySchema, body);
    await answering(() => this.feed.closeMany(tenant, close));
  }

  /** 204; 404 `feed_item_not_found` (closed, expired or not the member's). */
  @Post(':itemId/close')
  @HttpCode(204)
  @RequirePermission('feed.read')
  async close(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<void> {
    const { itemId } = parseBody(FeedItemParamsSchema, params);
    const close = parseBody(FeedCloseSchema, body);
    await answering(() => this.feed.close(tenant, itemId, close));
  }

  /** 200 the switches; 403 `forbidden` for staff. */
  @Patch('settings')
  @RequirePermission('settings.manage')
  async changeSettings(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<FeedSettings> {
    const change = parseBody(FeedSettingsChangeSchema, body);
    return FeedSettingsSchema.parse(
      await answering(() => this.feed.changeSettings(tenant, change)),
    );
  }
}
