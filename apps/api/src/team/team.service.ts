import type {
  AuditLogQuery,
  AuditLogResponse,
  Member,
  MembershipRole,
  UserId,
} from '@floty/contracts';
import {
  changeMemberRole,
  listMembers,
  readAuditLog,
  removeMember,
  type Actor,
  type TenantContext,
} from '@floty/core';
import type { Database } from '@floty/db';
import { currentRequestContext, DATABASE } from '@floty/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The core team and audit services for a request: binds the database and the request id (for
 * the audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class TeamService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  members(tenant: TenantContext): Promise<Member[]> {
    return listMembers(this.db, actorOf(tenant));
  }

  changeRole(tenant: TenantContext, userId: UserId, role: MembershipRole): Promise<Member> {
    return changeMemberRole(this.db, actorOf(tenant), userId, role);
  }

  remove(tenant: TenantContext, userId: UserId): Promise<void> {
    return removeMember(this.db, actorOf(tenant), userId);
  }

  auditLog(tenant: TenantContext, query: AuditLogQuery): Promise<AuditLogResponse> {
    return readAuditLog(this.db, actorOf(tenant), query);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
