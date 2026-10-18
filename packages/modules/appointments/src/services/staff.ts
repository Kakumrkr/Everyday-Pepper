import {
  StaffMemberIdSchema,
  StaffMemberInputSchema,
  type StaffMember,
  type StaffMemberFields,
  type StaffMemberId,
  type StaffMemberInput,
} from '@pepper/contracts';
import { MemberNotFoundError, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  findMembership,
  findServiceIds,
  insertStaffMember,
  listStaffMembers,
  lockStaffMember,
  replaceStaffServices,
  updateStaffMember as updateStaffMemberRow,
  withTenant,
  type Database,
  type StaffMemberRecord,
  type StaffMemberValues,
  type TenantTx,
} from '@pepper/db';
import { ServiceNotFoundError, StaffMemberNotFoundError } from '../errors.js';
import { sameValues, staffAuditValues, toStaffMember } from '../mapping.js';

// The people who can be booked (ADR-0015). Changes need `staff.manage` and are audited in the
// same transaction. Staff members are deactivated, not deleted: bookings will refer to them.

/** The business's staff members, by name. Needs `staff.read`. */
export async function listStaff(db: Database, actor: Actor): Promise<StaffMember[]> {
  requirePermission(actor, 'staff.read');
  const records = await withTenant(db, actor.context.tenantId, listStaffMembers);
  return records.map(toStaffMember);
}

/**
 * Adds a staff member. A `userId` must be a member of the business and not yet linked to
 * another staff member (`MemberNotFoundError`, `StaffMemberLinkTakenError`); every service id
 * must be one of the business's (`ServiceNotFoundError`).
 */
export async function createStaffMember(
  db: Database,
  actor: Actor,
  input: StaffMemberInput,
): Promise<StaffMember> {
  requirePermission(actor, 'staff.manage');
  const fields = StaffMemberInputSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const values = await resolve(tx, fields);
    const row = await insertStaffMember(tx, values);
    const id = StaffMemberIdSchema.parse(row.id);
    await replaceStaffServices(tx, id, fields.serviceIds);
    const created = await reread(tx, id);
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: actor.context.userId },
      change: {
        action: 'staff_member.created',
        entity: { type: 'staff_member', id },
        before: null,
        after: staffAuditValues(created),
      },
      requestId: actor.requestId,
    });
    return toStaffMember(created);
  });
}

/** Replaces a staff member's fields, login link and services (all of them). */
export async function updateStaffMember(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
  input: StaffMemberInput,
): Promise<StaffMember> {
  requirePermission(actor, 'staff.manage');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  const fields = StaffMemberInputSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const current = await lockStaffMember(tx, id);
    if (current === undefined) throw new StaffMemberNotFoundError();
    await updateStaffMemberRow(tx, id, await resolve(tx, fields));
    await replaceStaffServices(tx, id, fields.serviceIds);
    const updated = await reread(tx, id);
    const [before, after] = [staffAuditValues(current), staffAuditValues(updated)];
    if (!sameValues(before, after)) {
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: {
          action: 'staff_member.updated',
          entity: { type: 'staff_member', id },
          before,
          after,
        },
        requestId: actor.requestId,
      });
    }
    return toStaffMember(updated);
  });
}

/** Checks the login link and the services, and returns the row's values. */
async function resolve(tx: TenantTx, fields: StaffMemberFields): Promise<StaffMemberValues> {
  const found = await findServiceIds(tx, fields.serviceIds);
  if (found.length !== fields.serviceIds.length) throw new ServiceNotFoundError();
  let membershipId: string | null = null;
  if (fields.userId !== null) {
    const membership = await findMembership(tx, fields.userId);
    if (membership === undefined) throw new MemberNotFoundError();
    membershipId = membership.id;
  }
  const { displayName, color, active } = fields;
  return { displayName, color, active, membershipId };
}

async function reread(tx: TenantTx, id: StaffMemberId): Promise<StaffMemberRecord> {
  const record = await lockStaffMember(tx, id);
  if (record === undefined) throw new StaffMemberNotFoundError();
  return record;
}
