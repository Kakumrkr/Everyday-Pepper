import {
  BookingPageSettingsSchema,
  NewTenantSchema,
  SetActiveTenantRequestSchema,
  type Business,
  type CurrentBusinessResponse,
  type MeResponse,
  type TemplatesResponse,
} from '@pepper/contracts';
import { permissionsOf, type TenantContext } from '@pepper/core';
import { templateSummaries } from '@pepper/templates';
import {
  Body,
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
  RequirePermission,
  SessionGuard,
  TenantGuard,
} from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { TenancyService } from './tenancy.service.js';

/**
 * The signed-in user's account and businesses (`/v1/me`, `/v1/tenants`, `/v1/tenant`), and the
 * industry templates to start a business from (`/v1/templates`).
 */
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

  /** The business types a new business can start from (public data, but signed in only). */
  @Get('templates')
  @UseGuards(SessionGuard)
  templates(): TemplatesResponse {
    return { templates: templateSummaries() };
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

  /**
   * Creates a business owned by the user and makes it the session's active business. 409
   * `slug_taken`, or `business_limit_reached` once the user owns the most one may create.
   */
  @Post('tenants')
  @UseGuards(SessionGuard)
  async createBusiness(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<Business> {
    const input = parseBody(NewTenantSchema, body);
    const business = await answering(() => this.tenancy.createBusiness(session.user.id, input));
    await this.auth.setActiveTenant(session, business.id);
    return business;
  }

  /** The session's active business, the user's role in it and what that role may do. */
  @Get('tenant')
  @UseGuards(TenantGuard)
  @RequirePermission('business.read')
  async currentBusiness(@CurrentTenant() tenant: TenantContext): Promise<CurrentBusinessResponse> {
    const business = await this.tenancy.business(tenant.tenantId);
    // TenantGuard just found the membership, so the business exists (deleted concurrently: 403).
    if (business === null) throw new ForbiddenException(apiError('not_a_member'));
    return { business, role: tenant.role, permissions: permissionsOf(tenant.role) };
  }

  /** The booking page's settings: its color (PCR-001). Owners and managers. */
  @Put('tenant/booking-page')
  @UseGuards(TenantGuard)
  @RequirePermission('settings.manage')
  updateBookingPage(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<Business> {
    const settings = parseBody(BookingPageSettingsSchema, body);
    return answering(() => this.tenancy.updateBookingPage(tenant, settings));
  }
}
