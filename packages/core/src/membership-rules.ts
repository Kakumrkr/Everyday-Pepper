import type { MembershipRole, UserId } from '@floty/contracts';
import { can, permissionScope } from './permissions.js';

/** A change to someone's membership: a new role, or leaving the business. */
export type MembershipChange = { kind: 'change_role'; role: MembershipRole } | { kind: 'remove' };

export interface MembershipChangeInput {
  /** Who asks, with their role read in the same transaction as the change. */
  actor: { userId: UserId; role: MembershipRole };
  /** Whose membership changes, with their current role. */
  target: { userId: UserId; role: MembershipRole };
  change: MembershipChange;
  /** Owners of the business right now, read in the same (locked) transaction. */
  ownerCount: number;
}

/** Why a membership change is refused. */
export type MembershipChangeDenial = 'forbidden' | 'last_owner';

export type MembershipChangeDecision =
  { allowed: true } | { allowed: false; reason: MembershipChangeDenial };

/**
 * Decides whether a member may change someone's role or remove them (ADR-0013):
 * - anyone may leave a business themselves;
 * - otherwise it takes `members.manage` (owners and managers);
 * - only owners add, remove or change owners: a manager can neither touch an owner nor make
 *   anyone (themselves included) an owner;
 * - a business always keeps at least one owner.
 */
export function decideMembershipChange(input: MembershipChangeInput): MembershipChangeDecision {
  const { actor, target, change, ownerCount } = input;
  const leaving = change.kind === 'remove' && actor.userId === target.userId;
  if (!leaving) {
    if (!can(actor, 'members.manage')) return deny('forbidden');
    const touchesOwner =
      target.role === 'owner' || (change.kind === 'change_role' && change.role === 'owner');
    if (touchesOwner && actor.role !== 'owner') return deny('forbidden');
  }
  const losesOwner =
    target.role === 'owner' && (change.kind === 'remove' || change.role !== 'owner');
  if (losesOwner && ownerCount <= 1) return deny('last_owner');
  return { allowed: true };
}

function deny(reason: MembershipChangeDenial): MembershipChangeDecision {
  return { allowed: false, reason };
}

/**
 * Whether a member with `actorRole` may invite someone as `role` (ADR-0014): it takes
 * `members.invite`, and only owners make owners, as in `decideMembershipChange`.
 */
export function canGrantRole(actorRole: MembershipRole, role: MembershipRole): boolean {
  if (permissionScope(actorRole, 'members.invite') === null) return false;
  return role !== 'owner' || actorRole === 'owner';
}
