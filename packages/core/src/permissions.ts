import {
  PermissionSchema,
  type MembershipRole,
  type Permission,
  type UserId,
} from '@pepper/contracts';
import type { TenantContext } from './tenant-access.js';

/**
 * How far a role's permission reaches: every record in the business, or only the member's own
 * (their bookings, their notes, the clients they see). `null`: not at all.
 */
export type PermissionScope = 'all' | 'own' | null;

const ALL: Record<MembershipRole, PermissionScope> = { owner: 'all', manager: 'all', staff: 'all' };
const OWNER_ONLY: Record<MembershipRole, PermissionScope> = {
  owner: 'all',
  manager: null,
  staff: null,
};
const OWNER_AND_MANAGER: Record<MembershipRole, PermissionScope> = {
  owner: 'all',
  manager: 'all',
  staff: null,
};
const STAFF_OWN: Record<MembershipRole, PermissionScope> = {
  owner: 'all',
  manager: 'all',
  staff: 'own',
};

/**
 * The permission matrix (ADR-0013), approved by the user at S8:
 * - **owner**: everything.
 * - **manager**: everything except deleting the business and billing (and, in the membership
 *   rules, adding, removing or changing owners).
 * - **staff**: the business, services and the team's calendar; only their own bookings, clients
 *   and notes (AC-W9-1); no team, settings or trust changes.
 *
 * Exhaustive by type: a new `Permission` does not compile until it is given a row here, and the
 * matrix test pins every role × permission cell.
 */
export const PERMISSION_MATRIX: Readonly<
  Record<Permission, Readonly<Record<MembershipRole, PermissionScope>>>
> = {
  'business.read': ALL,
  'business.update': OWNER_AND_MANAGER,
  'business.delete': OWNER_ONLY,
  'billing.manage': OWNER_ONLY,
  'usage.read': OWNER_ONLY,
  'members.read': OWNER_AND_MANAGER,
  'members.invite': OWNER_AND_MANAGER,
  'members.manage': OWNER_AND_MANAGER,
  'audit.read': OWNER_AND_MANAGER,
  'autonomy.manage': OWNER_AND_MANAGER,
  'settings.manage': OWNER_AND_MANAGER,
  'integrations.manage': OWNER_AND_MANAGER,
  'services.read': ALL,
  'services.manage': OWNER_AND_MANAGER,
  // ADR-0015: staff see the team and its hours; they manage only their own time off (a staff
  // member is "theirs" when it is linked to their login), never their weekly hours.
  'staff.read': ALL,
  'staff.manage': OWNER_AND_MANAGER,
  'hours.manage': OWNER_AND_MANAGER,
  'time_off.manage': STAFF_OWN,
  // ADR-0016: everyone sees when the business can be booked; owners and managers set it.
  'rules.read': ALL,
  'rules.manage': OWNER_AND_MANAGER,
  'calendar.read': ALL,
  'bookings.read': STAFF_OWN,
  'bookings.manage': STAFF_OWN,
  'clients.read': STAFF_OWN,
  'clients.manage': OWNER_AND_MANAGER,
  'client_notes.read': STAFF_OWN,
  'client_notes.manage': STAFF_OWN,
  // ADR-0026: staff reach the tasks assigned to them or that they created.
  'tasks.read': STAFF_OWN,
  'tasks.manage': STAFF_OWN,
};

/** How far `role`'s `permission` reaches. */
export function permissionScope(role: MembershipRole, permission: Permission): PermissionScope {
  return PERMISSION_MATRIX[permission][role];
}

/**
 * Every permission `role` has, at any scope, in `PermissionSchema` order: what the UI may offer
 * (`GET /v1/tenant`). The api still checks each action.
 */
export function permissionsOf(role: MembershipRole): Permission[] {
  return PermissionSchema.options.filter(
    (permission) => permissionScope(role, permission) !== null,
  );
}

/** The record a permission is checked against: whose it is (`null`: nobody's, e.g. unassigned). */
export interface OwnedRecord {
  ownerUserId: UserId | null;
}

/**
 * Whether the member may use `permission`, on `record` when given. Without a record this
 * answers "at all" (an `own` scope counts), which is what route guards check; services then
 * check the record itself, so staff reach only records they own.
 */
export function can(
  actor: Pick<TenantContext, 'userId' | 'role'>,
  permission: Permission,
  record?: OwnedRecord,
): boolean {
  const scope = permissionScope(actor.role, permission);
  // Fail closed: a role the matrix does not know (never stored, but typed only) reaches nothing.
  if (scope !== 'all' && scope !== 'own') return false;
  if (scope === 'all' || record === undefined) return true;
  return record.ownerUserId !== null && record.ownerUserId === actor.userId;
}
