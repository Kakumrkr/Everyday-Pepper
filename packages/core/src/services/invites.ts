import {
  CreateInviteRequestSchema,
  InviteEmailSchema,
  InvitePreviewResponseSchema,
  InviteSchema,
  MembershipRoleSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type AcceptInviteResponse,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type Invite,
  type InvitePreviewResponse,
  type InviteToken,
  type MembershipRole,
  type UserId,
} from '@floty/contracts';
import {
  addMembership,
  appendAuditEntry,
  countOpenInvites,
  findCurrentTenant,
  findMembership,
  insertInvite,
  isMemberEmail,
  listOpenInvites,
  lockInvite,
  lockTenantMemberships,
  lockUnresolvedInvitesFor,
  markInviteAccepted,
  revokeInvite as revokeInviteRow,
  withInviteTenant,
  withTenant,
  type Database,
  type InviteRow,
  type TenantTx,
} from '@floty/db';
import { requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import {
  AlreadyAMemberError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
} from '../errors.js';
import { hashInviteToken, newInviteToken } from '../invite-token.js';
import { canGrantRole } from '../membership-rules.js';

// Invites (ADR-0014). An owner or manager invites one email with a role they may grant; the
// link carries a random token whose SHA-256 hash is stored. The invitee signs in with that
// email and accepts: the membership, the invite's acceptance and the audit entry commit
// together. Changes lock the business's memberships (as team changes do) and the invite row.

/** How long an invite link works (S9, approved by the user). */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** The most open invites a business may have at once (S9, approved by the user). */
export const INVITE_LIMIT_PER_BUSINESS = 20;

/** The signed-in user an invite is accepted for: from the session, never from the body. */
export interface Invitee {
  userId: UserId;
  email: string;
}

export interface InviteOptions {
  clock?: Clock;
}

/** The business's open invites, newest first. Needs `members.read` (they hold emails). */
export async function listInvites(
  db: Database,
  actor: Actor,
  options: InviteOptions = {},
): Promise<Invite[]> {
  requirePermission(actor, 'members.read');
  const now = (options.clock ?? systemClock).now();
  const rows = await withTenant(db, actor.context.tenantId, (tx) => listOpenInvites(tx, now));
  return rows.map(toInvite);
}

/**
 * Invites `email` as `role`; returns the invite and its token (shown once). Needs
 * `members.invite` and a role the actor may grant. An earlier unresolved invite for the same
 * email is revoked, so inviting again replaces a lost link.
 */
export async function createInvite(
  db: Database,
  actor: Actor,
  request: CreateInviteRequest,
  options: InviteOptions = {},
): Promise<CreateInviteResponse> {
  requirePermission(actor, 'members.invite');
  const { email, role } = CreateInviteRequestSchema.parse(request);
  const now = (options.clock ?? systemClock).now();
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const actorRole = await lockAndReadRole(tx, actor);
    if (!canGrantRole(actorRole, role)) throw new ForbiddenError('members.invite');
    if (await isMemberEmail(tx, email)) throw new AlreadyAMemberError();
    for (const earlier of await lockUnresolvedInvitesFor(tx, email)) {
      await revokeLocked(tx, actor, actorRole, earlier, now);
    }
    if ((await countOpenInvites(tx, now)) >= INVITE_LIMIT_PER_BUSINESS) {
      throw new InviteLimitReachedError(INVITE_LIMIT_PER_BUSINESS);
    }
    const token = newInviteToken();
    const invite = await insertInvite(tx, {
      email,
      role,
      tokenHash: hashInviteToken(token),
      invitedBy: actor.context.userId,
      expiresAt: new Date(now.getTime() + INVITE_LIFETIME_MS),
    });
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: actor.context.userId },
      change: {
        action: 'invite.created',
        entity: { type: 'invite', id: invite.id },
        before: null,
        after: {
          role: invite.role,
          expiresAt: UtcDateTimeSchema.parse(invite.expiresAt.toISOString()),
        },
      },
      requestId: actor.requestId,
    });
    return { invite: toInvite(invite), token };
  });
}

/**
 * Revokes an unresolved invite of the actor's business. Needs `members.invite`; only owners
 * revoke an invite to become an owner. `InviteNotFoundError` if there is no such invite.
 */
export async function revokeInvite(
  db: Database,
  actor: Actor,
  inviteId: string,
  options: InviteOptions = {},
): Promise<void> {
  requirePermission(actor, 'members.invite');
  const id = InviteSchema.shape.id.parse(inviteId);
  const now = (options.clock ?? systemClock).now();
  await withTenant(db, actor.context.tenantId, async (tx) => {
    const actorRole = await lockAndReadRole(tx, actor);
    const invite = await lockInvite(tx, id);
    if (invite === undefined || !isUnresolved(invite)) throw new InviteNotFoundError();
    await revokeLocked(tx, actor, actorRole, invite, now);
  });
}

/**
 * What the signed-in invitee would join with this token. Throws `InviteInvalidError` for a
 * token that does not work, `InviteWrongAccountError` if it is for another email and
 * `AlreadyAMemberError` if they belong to the business already.
 */
export async function previewInvite(
  db: Database,
  invitee: Invitee,
  token: InviteToken,
  options: InviteOptions = {},
): Promise<InvitePreviewResponse> {
  const now = (options.clock ?? systemClock).now();
  const preview = await withInviteTenant(
    db,
    hashInviteToken(token),
    async (tx, invite) => {
      await checkAcceptable(tx, invite, invitee, now);
      const tenant = await findCurrentTenant(tx);
      if (tenant === undefined) throw new InviteInvalidError();
      return InvitePreviewResponseSchema.parse({
        businessName: tenant.name,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
      });
    },
    { readOnly: true },
  );
  if (preview === undefined) throw new InviteInvalidError();
  return preview;
}

/**
 * Accepts the invite for the signed-in invitee: they become a member with the invite's role,
 * the invite is used up, and `invite.accepted` is written, in one transaction. Errors as
 * `previewInvite`. Concurrent acceptances of one token: exactly one wins.
 */
export async function acceptInvite(
  db: Database,
  invitee: Invitee,
  token: InviteToken,
  options: InviteOptions & { requestId?: string | undefined } = {},
): Promise<AcceptInviteResponse> {
  const now = (options.clock ?? systemClock).now();
  const userId = UserIdSchema.parse(invitee.userId);
  const accepted = await withInviteTenant(db, hashInviteToken(token), async (tx, found) => {
    await lockTenantMemberships(tx);
    const invite = await lockInvite(tx, found.id);
    if (invite === undefined) throw new InviteInvalidError();
    await checkAcceptable(tx, invite, invitee, now);
    const role = MembershipRoleSchema.parse(invite.role);
    const membership = await addMembership(tx, { userId, role });
    if ((await markInviteAccepted(tx, invite.id, userId, now)) === undefined) {
      throw new InviteInvalidError();
    }
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId },
      change: {
        action: 'invite.accepted',
        entity: { type: 'invite', id: invite.id },
        before: { role },
        after: { userId, role, membershipId: membership.id },
      },
      requestId: options.requestId,
    });
    return { tenantId: TenantIdSchema.parse(invite.tenantId), role };
  });
  if (accepted === undefined) throw new InviteInvalidError();
  return accepted;
}

/** Locks the business's memberships and re-reads the actor's role (it may have changed). */
async function lockAndReadRole(tx: TenantTx, actor: Actor): Promise<MembershipRole> {
  await lockTenantMemberships(tx);
  const own = await findMembership(tx, actor.context.userId);
  if (own === undefined) throw new ForbiddenError();
  return own.role;
}

async function revokeLocked(
  tx: TenantTx,
  actor: Actor,
  actorRole: MembershipRole,
  invite: InviteRow,
  now: Date,
): Promise<void> {
  if (!canGrantRole(actorRole, invite.role)) throw new ForbiddenError('members.invite');
  if ((await revokeInviteRow(tx, invite.id, now)) === undefined) throw new InviteNotFoundError();
  await appendAuditEntry(tx, {
    actor: { kind: 'user', userId: actor.context.userId },
    change: {
      action: 'invite.revoked',
      entity: { type: 'invite', id: invite.id },
      before: { role: invite.role },
      after: null,
    },
    requestId: actor.requestId,
  });
}

/** Throws unless `invitee` may accept `invite` at `now`. */
async function checkAcceptable(
  tx: TenantTx,
  invite: InviteRow,
  invitee: Invitee,
  now: Date,
): Promise<void> {
  if (!isUnresolved(invite) || invite.expiresAt <= now) throw new InviteInvalidError();
  const email = InviteEmailSchema.safeParse(invitee.email);
  if (!email.success || email.data !== invite.email) throw new InviteWrongAccountError();
  if ((await findMembership(tx, UserIdSchema.parse(invitee.userId))) !== undefined) {
    throw new AlreadyAMemberError();
  }
}

/** Neither accepted nor revoked (it may have expired). */
function isUnresolved(invite: InviteRow): boolean {
  return invite.acceptedAt === null && invite.revokedAt === null;
}

function toInvite(row: InviteRow): Invite {
  return InviteSchema.parse({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedByUserId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  });
}
