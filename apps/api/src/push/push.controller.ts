import {
  PushEndpointSchema,
  PushSubscriptionInputSchema,
  type PushKeyResponse,
  type PushStatusResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { apiError, CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { PushService } from './push.service.js';
import { PUSH_OPTIONS, type PushOptions } from './team-pushes.js';

/**
 * Notifications on this device, `/v1/push` (ADR-0026): the public key a browser subscribes
 * with, and the member's device on or off in the active business. Each member reaches only
 * their own devices. The endpoint travels in bodies, never in URLs (it is a capability).
 */
@Controller('v1/push')
@UseGuards(TenantGuard)
export class PushController {
  constructor(
    private readonly push: PushService,
    @Inject(PUSH_OPTIONS) private readonly options: PushOptions,
  ) {}

  /** `{ publicKey }`, `null` when this deployment sends no pushes. */
  @Get('key')
  @RequirePermission('business.read')
  key(): PushKeyResponse {
    return { publicKey: this.options.publicKey };
  }

  /** 204: this device gets the member's pushes; 503 `push_unavailable` when pushes are off. */
  @Put('subscription')
  @HttpCode(204)
  @RequirePermission('business.read')
  async save(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<void> {
    const input = parseBody(PushSubscriptionInputSchema, body);
    if (this.options.publicKey === null) {
      throw new ServiceUnavailableException(apiError('push_unavailable'));
    }
    await answering(() => this.push.save(tenant, input));
  }

  /** 204: this device no longer gets them (also when it did not). */
  @Delete('subscription')
  @HttpCode(204)
  @RequirePermission('business.read')
  async remove(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<void> {
    const device = parseBody(PushEndpointSchema, body);
    await answering(() => this.push.remove(tenant, device));
  }

  /** 200 `{ subscribed }` for this device. A POST, so the endpoint stays out of URLs and logs. */
  @Post('subscription/status')
  @HttpCode(200)
  @RequirePermission('business.read')
  async status(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<PushStatusResponse> {
    const device = parseBody(PushEndpointSchema, body);
    return { subscribed: await answering(() => this.push.status(tenant, device)) };
  }
}
