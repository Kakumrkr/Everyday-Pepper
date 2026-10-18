import {
  MemberSchema,
  MembershipRoleSchema,
  UserIdSchema,
  type Member,
  type MembershipRole,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  countOwners,
  deleteMembership,
  findMembership,
  listTenantMembers,
  lockTenantMemberships,
  updateMembershipRole,
  withTenant,
  type Database,
  type Membership,
  type TenantMember,
  type TenantTx,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { ForbiddenError, LastOwnerError, MemberNotFoundError } from '../errors.js';
import { decideMembershipChange, type MembershipChange } from '../membership-rules.js';

// The team of a business (ADR-0013): list members, change a role, remove someone or leave.
// Every change locks the business's memberships, re-reads the actor's own role in the same
// transaction (it may have changed since the request was authorised), applies
// `decideMembershipChange`, and writes its audit entry before commit.

/** Everyone in the actor's business. Needs `members.read`. */
export async function listMembers(db: Database, actor: Actor): Promise<Member[]> {
  requirePermission(actor, 'members.read');
  const members = await withTenant(db, actor.context.tenantId, listTenantMembers);
  return members.map(toMember);
}

/** Gives a member another role; returns them as listed. A change to the same role is a no-op. */
export async function changeMemberRole(
  db: Database,
  actor: Actor,
  targetUserId: UserId,
  role: MembershipRole,
): Promise<Member> {
  requirePermission(actor, 'members.manage');
  const target = UserIdSchema.parse(targetUserId);
  const newRole = MembershipRoleSchema.parse(role);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const current = await authorise(tx, actor, target, { kind: 'change_role', role: newRole });
    if (current.role !== newRole) {
      await updateMembershipRole(tx, target, newRole);
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: {
          action: 'membership.role_changed',
          entity: { type: 'membership', id: current.id },
          before: { userId: target, role: current.role },
          after: { userId: target, role: newRole },
        },
        requestId: actor.requestId,
      });
    }
    const member = (await listTenantMembers(tx)).find((m) => m.userId === target);
    if (member === undefined) throw new MemberNotFoundError();
    return toMember(member);
  });
}

/**
 * Removes a member from the actor's business; with the actor's own id, leaves it. Removing
 * someone else needs `members.manage`; anyone may leave, except the last owner.
 */
export async function removeMember(
  db: Database,
  actor: Actor,
  targetUserId: UserId,
): Promise<void> {
  const target = UserIdSchema.parse(targetUserId);
  // Checked before any lookup, so staff cannot probe who belongs to the business.
  if (target !== actor.context.userId) requirePermission(actor, 'members.manage');
  await withTenant(db, actor.context.tenantId, async (tx) => {
    const current = await authorise(tx, actor, target, { kind: 'remove' });
    await deleteMembership(tx, target);
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: actor.context.userId },
      change: {
        action: 'membership.removed',
        entity: { type: 'membership', id: current.id },
        before: { userId: target, role: current.role },
        after: null,
      },
      requestId: actor.requestId,
    });
  });
}

/** Locks, re-reads both memberships and the owner count, and decides. Returns the target's. */
async function authorise(
  tx: TenantTx,
  actor: Actor,
  target: UserId,
  change: MembershipChange,
): Promise<Membership> {
  await lockTenantMemberships(tx);
  const own = await findMembership(tx, actor.context.userId);
  if (own === undefined) throw new ForbiddenError();
  const current = target === actor.context.userId ? own : await findMembership(tx, target);
  if (current === undefined) throw new MemberNotFoundError();
  const decision = decideMembershipChange({
    actor: { userId: actor.context.userId, role: own.role },
    target: { userId: target, role: current.role },
    change,
    ownerCount: await countOwners(tx),
  });
  if (!decision.allowed) {
    throw decision.reason === 'last_owner'
      ? new LastOwnerError()
      : new ForbiddenError('members.manage');
  }
  return current;
}

function toMember(member: TenantMember): Member {
  const { userId, name, email, role, joinedAt } = member;
  return MemberSchema.parse({ userId, name, email, role, joinedAt: joinedAt.toISOString() });
}
