import { MembershipRoleSchema, UserIdSchema, type MembershipRole } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  canGrantRole,
  decideMembershipChange,
  type MembershipChange,
  type MembershipChangeDecision,
} from './membership-rules.js';

const ME = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const OTHER = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');
const ROLES = MembershipRoleSchema.options;
const CHANGES: MembershipChange[] = [
  ...ROLES.map((role) => ({ kind: 'change_role', role }) as const),
  { kind: 'remove' },
];

const allowed: MembershipChangeDecision = { allowed: true };
const forbidden: MembershipChangeDecision = { allowed: false, reason: 'forbidden' };
const lastOwner: MembershipChangeDecision = { allowed: false, reason: 'last_owner' };

function decide(
  actorRole: MembershipRole,
  targetRole: MembershipRole,
  change: MembershipChange,
  { self = false, ownerCount = 2 } = {},
) {
  return decideMembershipChange({
    actor: { userId: ME, role: actorRole },
    target: { userId: self ? ME : OTHER, role: targetRole },
    change,
    ownerCount,
  });
}

describe('decideMembershipChange', () => {
  // Someone else's membership, with two owners in the business.
  //                       target:  owner      manager    staff
  const OTHERS: Record<MembershipRole, Record<string, MembershipChangeDecision[]>> = {
    owner: {
      'make owner': [allowed, allowed, allowed],
      'make manager': [allowed, allowed, allowed],
      'make staff': [allowed, allowed, allowed],
      remove: [allowed, allowed, allowed],
    },
    manager: {
      'make owner': [forbidden, forbidden, forbidden],
      'make manager': [forbidden, allowed, allowed],
      'make staff': [forbidden, allowed, allowed],
      remove: [forbidden, allowed, allowed],
    },
    staff: {
      'make owner': [forbidden, forbidden, forbidden],
      'make manager': [forbidden, forbidden, forbidden],
      'make staff': [forbidden, forbidden, forbidden],
      remove: [forbidden, forbidden, forbidden],
    },
  };
  const label = (change: MembershipChange) =>
    change.kind === 'remove' ? 'remove' : `make ${change.role}`;
  const otherCases = ROLES.flatMap((actor) =>
    CHANGES.flatMap((change) =>
      ROLES.map((target, column) => ({
        actor,
        target,
        change,
        expected: OTHERS[actor][label(change)]?.[column],
      })),
    ),
  );

  it.each(otherCases)(
    'a(n) $actor changing a(n) $target: $change.kind $change.role',
    ({ actor, target, change, expected }) => {
      expect(decide(actor, target, change)).toEqual(expected);
    },
  );

  it.each(ROLES)('a(n) %s may leave the business', (role) => {
    expect(decide(role, role, { kind: 'remove' }, { self: true })).toEqual(allowed);
  });

  it('the last owner can neither leave nor be demoted, by anyone', () => {
    expect(decide('owner', 'owner', { kind: 'remove' }, { self: true, ownerCount: 1 })).toEqual(
      lastOwner,
    );
    expect(
      decide(
        'owner',
        'owner',
        { kind: 'change_role', role: 'manager' },
        { self: true, ownerCount: 1 },
      ),
    ).toEqual(lastOwner);
    // Unreachable in practice (the last owner is the only owner), but the rule holds anyway.
    expect(decide('owner', 'owner', { kind: 'remove' }, { ownerCount: 1 })).toEqual(lastOwner);
  });

  it('the last owner may "change" to owner (a no-op)', () => {
    expect(
      decide(
        'owner',
        'owner',
        { kind: 'change_role', role: 'owner' },
        { self: true, ownerCount: 1 },
      ),
    ).toEqual(allowed);
  });

  it('an owner may step down while another owner remains', () => {
    expect(
      decide('owner', 'owner', { kind: 'change_role', role: 'staff' }, { self: true }),
    ).toEqual(allowed);
  });

  it('a manager may step down to staff but not promote themselves', () => {
    const self = { self: true };
    expect(decide('manager', 'manager', { kind: 'change_role', role: 'staff' }, self)).toEqual(
      allowed,
    );
    expect(decide('manager', 'manager', { kind: 'change_role', role: 'owner' }, self)).toEqual(
      forbidden,
    );
  });

  it('staff cannot change their own role', () => {
    for (const role of ROLES) {
      expect(decide('staff', 'staff', { kind: 'change_role', role }, { self: true })).toEqual(
        forbidden,
      );
    }
  });

  it('never leaves a business without an owner', () => {
    for (const actor of ROLES)
      for (const target of ROLES)
        for (const change of CHANGES)
          for (const self of [false, true]) {
            const decision = decide(actor, target, change, { self, ownerCount: 1 });
            const removesOwner =
              target === 'owner' && (change.kind === 'remove' || change.role !== 'owner');
            if (removesOwner) expect(decision.allowed).toBe(false);
          }
  });
});

describe('canGrantRole', () => {
  // Who may invite someone as which role (ADR-0014).
  //                                  as: owner  manager staff
  const GRANTS: Record<MembershipRole, [boolean, boolean, boolean]> = {
    owner: [true, true, true],
    manager: [false, true, true],
    staff: [false, false, false],
  };
  const cases = ROLES.flatMap((actor) =>
    ROLES.map((role, column) => ({ actor, role, expected: GRANTS[actor][column] })),
  );

  it.each(cases)('a(n) $actor inviting as $role → $expected', ({ actor, role, expected }) => {
    expect(canGrantRole(actor, role)).toBe(expected);
  });
});
