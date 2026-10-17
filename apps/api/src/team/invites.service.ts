import type {
  AcceptInviteResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  Invite,
  InvitePreviewResponse,
  InviteToken,
} from '@floty/contracts';
import {
  acceptInvite,
  createInvite,
  listInvites,
  previewInvite,
  revokeInvite,
  type Actor,
  type Invitee,
  type TenantContext,
} from '@floty/core';
import type { Database } from '@floty/db';
import { currentRequestContext, DATABASE } from '@floty/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The core invite services for a request: binds the database and the request id (for the
 * audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class InvitesService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  list(tenant: TenantContext): Promise<Invite[]> {
    return listInvites(this.db, actorOf(tenant));
  }

  create(tenant: TenantContext, request: CreateInviteRequest): Promise<CreateInviteResponse> {
    return createInvite(this.db, actorOf(tenant), request);
  }

  revoke(tenant: TenantContext, inviteId: string): Promise<void> {
    return revokeInvite(this.db, actorOf(tenant), inviteId);
  }

  preview(invitee: Invitee, token: InviteToken): Promise<InvitePreviewResponse> {
    return previewInvite(this.db, invitee, token);
  }

  accept(invitee: Invitee, token: InviteToken): Promise<AcceptInviteResponse> {
    return acceptInvite(this.db, invitee, token, {
      requestId: currentRequestContext()?.requestId,
    });
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
