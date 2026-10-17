import {
  NewTenantSchema,
  SetActiveTenantRequestSchema,
  type Business,
  type CurrentBusinessResponse,
  type MeResponse,
} from '@floty/contracts';
import type { TenantContext } from '@floty/core';
import { TenantSlugTakenError } from '@floty/db';
import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import {
  apiError,
  CurrentSession,
  CurrentTenant,
  SessionGuard,
  TenantGuard,
} from '../auth/guards.js';
import { parseBody } from '../http/zod-body.js';
import { TenancyService } from './tenancy.service.js';

/** The signed-in user's account and businesses (`/v1/me`, `/v1/tenants`, `/v1/tenant`). */
@Controller('v1')
export class AccountController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
  ) {}

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentSession() session: AuthSession): Promise<MeResponse> {
    return {
      user: session.user,
      activeTenantId: session.activeTenantId,
      businesses: await this.tenancy.businessesOf(session.user.id),
    };
  }

  /** Switches the session to one of the user's own businesses. */
  @Put('me/active-tenant')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async setActiveTenant(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<void> {
    const { tenantId } = parseBody(SetActiveTenantRequestSchema, body);
    if ((await this.tenancy.roleIn(tenantId, session.user.id)) === null) {
      throw new ForbiddenException(apiError('not_a_member'));
    }
    await this.auth.setActiveTenant(session, tenantId);
  }

  /** Creates a business owned by the user and makes it the session's active business. */
  @Post('tenants')
  @UseGuards(SessionGuard)
  async createBusiness(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<Business> {
    const input = parseBody(NewTenantSchema, body);
    try {
      const business = await this.tenancy.createBusiness(session.user.id, input);
      await this.auth.setActiveTenant(session, business.id);
      return business;
    } catch (error) {
      if (error instanceof TenantSlugTakenError) {
        throw new ConflictException(apiError('slug_taken'));
      }
      throw error;
    }
  }

  /** The session's active business and the user's role in it. */
  @Get('tenant')
  @UseGuards(TenantGuard)
  async currentBusiness(@CurrentTenant() tenant: TenantContext): Promise<CurrentBusinessResponse> {
    const business = await this.tenancy.business(tenant.tenantId);
    // TenantGuard just found the membership, so the business exists (deleted concurrently: 403).
    if (business === null) throw new ForbiddenException(apiError('not_a_member'));
    return { business, role: tenant.role };
  }
}
