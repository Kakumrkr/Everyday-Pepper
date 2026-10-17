import {
  CreateInviteRequestSchema,
  InviteSchema,
  InviteTokenRequestSchema,
  type AcceptInviteResponse,
  type CreateInviteResponse,
  type InvitePreviewResponse,
  type InvitesResponse,
} from '@floty/contracts';
import type { Invitee, TenantContext } from '@floty/core';
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import {
  CurrentSession,
  CurrentTenant,
  RequirePermission,
  SessionGuard,
  TenantGuard,
} from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { InvitesService } from './invites.service.js';

const InviteParamsSchema = z.object({ inviteId: InviteSchema.shape.id });

/**
 * Invites (ADR-0014). Owners and managers manage the active business's invites; the invitee,
 * signed in but not a member yet, looks one up and accepts it with the link's token. The
 * business of an acceptance comes from the invite the token names, never from the body.
 */
@Controller('v1/invites')
export class InvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @UseGuards(TenantGuard)
  @RequirePermission('members.read')
  async list(@CurrentTenant() tenant: TenantContext): Promise<InvitesResponse> {
    return { invites: await answering(() => this.invites.list(tenant)) };
  }

  /**
   * Creates an invite; the token is in this response only. 403 `forbidden` for a role the
   * user may not grant, 409 `already_a_member` or `invite_limit_reached`.
   */
  @Post()
  @UseGuards(TenantGuard)
  @RequirePermission('members.invite')
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<CreateInviteResponse> {
    const request = parseBody(CreateInviteRequestSchema, body);
    return answering(() => this.invites.create(tenant, request));
  }

  /** Revokes an open invite. 404 `invite_not_found`. */
  @Delete(':inviteId')
  @HttpCode(204)
  @UseGuards(TenantGuard)
  @RequirePermission('members.invite')
  async revoke(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { inviteId } = parseBody(InviteParamsSchema, params);
    await answering(() => this.invites.revoke(tenant, inviteId));
  }

  /**
   * What the signed-in user would join. 404 `invite_invalid`, 403 `invite_wrong_account`,
   * 409 `already_a_member`. A POST, so the token stays out of URLs and logs.
   */
  @Post('lookup')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async lookup(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<InvitePreviewResponse> {
    const { token } = parseBody(InviteTokenRequestSchema, body);
    return answering(() => this.invites.preview(inviteeOf(session), token));
  }

  /** Joins the business and makes it the session's active business. Errors as `lookup`. */
  @Post('accept')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async accept(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<AcceptInviteResponse> {
    const { token } = parseBody(InviteTokenRequestSchema, body);
    const accepted = await answering(() => this.invites.accept(inviteeOf(session), token));
    await this.auth.setActiveTenant(session, accepted.tenantId);
    return accepted;
  }
}

function inviteeOf(session: AuthSession): Invitee {
  return { userId: session.user.id, email: session.user.email };
}
