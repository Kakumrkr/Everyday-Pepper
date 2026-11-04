import {
  MembershipRoleSchema,
  PermissionSchema,
  UserIdSchema,
  type MembershipRole,
  type Permission,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  can,
  PERMISSION_MATRIX,
  permissionScope,
  permissionsOf,
  type PermissionScope,
} from './permissions.js';

// The role matrix, written out cell by cell (Phase 2 exit: "role matrix 100%"). Changing a cell
// here is a permission change: it needs the user's approval and an ADR-0013 update.
//                          owner    manager  staff
const EXPECTED: Record<Permission, [PermissionScope, PermissionScope, PermissionScope]> = {
  'business.read': ['all', 'all', 'all'],
  'business.update': ['all', 'all', null],
  'business.delete': ['all', null, null],
  'business.export': ['all', null, null],
  'billing.manage': ['all', null, null],
  'usage.read': ['all', null, null],
  'members.read': ['all', 'all', null],
  'members.invite': ['all', 'all', null],
  'members.manage': ['all', 'all', null],
  'audit.read': ['all', 'all', null],
  'autonomy.manage': ['all', 'all', null],
  'settings.manage': ['all', 'all', null],
  'integrations.manage': ['all', 'all', null],
  'services.read': ['all', 'all', 'all'],
  'services.manage': ['all', 'all', null],
  'staff.read': ['all', 'all', 'all'],
  'staff.manage': ['all', 'all', null],
  'hours.manage': ['all', 'all', null],
  'time_off.manage': ['all', 'all', 'own'],
  'rules.read': ['all', 'all', 'all'],
  'rules.manage': ['all', 'all', null],
  'calendar.read': ['all', 'all', 'all'],
  'bookings.read': ['all', 'all', 'own'],
  'bookings.manage': ['all', 'all', 'own'],
  'clients.read': ['all', 'all', 'own'],
  'clients.manage': ['all', 'all', null],
  'client_notes.read': ['all', 'all', 'own'],
  'client_notes.manage': ['all', 'all', 'own'],
  'tasks.read': ['all', 'all', 'own'],
  'tasks.manage': ['all', 'all', 'own'],
  'ai.chat': ['all', 'all', 'own'],
  'feed.read': ['all', 'all', 'own'],
};

const ROLES = MembershipRoleSchema.options;
const cells = PermissionSchema.options.flatMap((permission) =>
  ROLES.map((role, column) => ({ permission, role, scope: EXPECTED[permission][column] })),
);

const ME = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const COLLEAGUE = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194');

describe('PERMISSION_MATRIX', () => {
  it('has a row for every permission and nothing else', () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...PermissionSchema.options].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...PermissionSchema.options].sort());
  });

  it.each(cells)('$role / $permission → $scope', ({ permission, role, scope }) => {
    expect(permissionScope(role, permission)).toBe(scope);
  });

  it('gives owners everything', () => {
    for (const permission of PermissionSchema.options) {
      expect(permissionScope('owner', permission)).toBe('all');
    }
  });

  it('never gives a lower role more than a higher one', () => {
    const rank: Record<NonNullable<PermissionScope> | 'none', number> = { none: 0, own: 1, all: 2 };
    const reach = (role: MembershipRole, permission: Permission) =>
      rank[permissionScope(role, permission) ?? 'none'];
    for (const permission of PermissionSchema.options) {
      expect(reach('owner', permission)).toBeGreaterThanOrEqual(reach('manager', permission));
      expect(reach('manager', permission)).toBeGreaterThanOrEqual(reach('staff', permission));
    }
  });
});

describe('can', () => {
  it.each(cells)('$role / $permission without a record', ({ permission, role, scope }) => {
    expect(can({ userId: ME, role }, permission)).toBe(scope !== null);
  });

  it.each(cells)('$role / $permission on their own record', ({ permission, role, scope }) => {
    expect(can({ userId: ME, role }, permission, { ownerUserId: ME })).toBe(scope !== null);
  });

  it.each(cells)("$role / $permission on a colleague's record", ({ permission, role, scope }) => {
    expect(can({ userId: ME, role }, permission, { ownerUserId: COLLEAGUE })).toBe(scope === 'all');
  });

  it.each(cells)('$role / $permission on an unassigned record', ({ permission, role, scope }) => {
    expect(can({ userId: ME, role }, permission, { ownerUserId: null })).toBe(scope === 'all');
  });

  it("AC-W9-1: staff edit their own bookings and notes, never a colleague's", () => {
    const staff = { userId: ME, role: 'staff' } as const;
    for (const permission of ['bookings.manage', 'client_notes.manage'] as const) {
      expect(can(staff, permission, { ownerUserId: ME })).toBe(true);
      expect(can(staff, permission, { ownerUserId: COLLEAGUE })).toBe(false);
    }
    expect(
      can({ userId: ME, role: 'manager' }, 'bookings.manage', { ownerUserId: COLLEAGUE }),
    ).toBe(true);
  });
});

describe('permissionsOf', () => {
  it.each(ROLES.map((role, column) => ({ role, column })))(
    'lists exactly the permissions a(n) $role has at any scope, in schema order',
    ({ role, column }) => {
      const expected = PermissionSchema.options.filter((p) => EXPECTED[p][column] !== null);
      expect(permissionsOf(role)).toEqual(expected);
    },
  );

  it('gives staff no team, trust or settings permissions', () => {
    const staff = permissionsOf('staff');
    for (const permission of ['members.read', 'members.invite', 'audit.read'] as const) {
      expect(staff).not.toContain(permission);
    }
  });
});

describe('can with a role the matrix does not know', () => {
  it('refuses everything (fails closed)', () => {
    const stranger = {
      userId: UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193'),
      role: 'guest' as MembershipRole,
    };
    for (const permission of PermissionSchema.options) {
      expect(can(stranger, permission), permission).toBe(false);
    }
  });
});
