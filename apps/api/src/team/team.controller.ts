import {
  AuditLogQuerySchema,
  ChangeMemberRoleRequestSchema,
  UserIdSchema,
  type AuditLogResponse,
  type Member,
  type MembersResponse,
} from '@floty/contracts';
import type { TenantContext } from '@floty/core';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import { CurrentSession, CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { TeamService } from './team.service.js';

const MemberParamsSchema = z.object({ userId: UserIdSchema });

/**
 * The active business's team and audit log (ADR-0013): `/v1/members` and `/v1/audit-log`.
 * Permissions are checked by the route guard and again by the domain services, which also
 * apply the membership rules and write the audit entries.
 */
@Controller('v1')
@UseGuards(TenantGuard)
export class TeamController {
  constructor(
    private readonly team: TeamService,
    private readonly auth: AuthService,
  ) {}

  @Get('members')
  @RequirePermission('members.read')
  async members(@CurrentTenant() tenant: TenantContext): Promise<MembersResponse> {
    return { members: await answering(() => this.team.members(tenant)) };
  }

  /** Gives a member another role. 403 `forbidden`, 404 `member_not_found`, 409 `last_owner`. */
  @Patch('members/:userId')
  @RequirePermission('members.manage')
  async changeRole(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Member> {
    const { userId } = parseBody(MemberParamsSchema, params);
    const { role } = parseBody(ChangeMemberRoleRequestSchema, body);
    return answering(() => this.team.changeRole(tenant, userId, role));
  }

  /**
   * Removes a member; with one's own id, leaves the business (any role, except the last
   * owner), and the session no longer has an active business.
   */
  @Delete('members/:userId')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenant: TenantContext,
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
  ): Promise<void> {
    const { userId } = parseBody(MemberParamsSchema, params);
    await answering(() => this.team.remove(tenant, userId));
    if (userId === tenant.userId) await this.auth.setActiveTenant(session, null);
  }

  @Get('audit-log')
  @RequirePermission('audit.read')
  async auditLog(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<AuditLogResponse> {
    const parsed = parseBody(AuditLogQuerySchema, query);
    return answering(() => this.team.auditLog(tenant, parsed));
  }
}
