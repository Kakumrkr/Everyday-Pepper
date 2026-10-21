import {
  StaffMemberIdSchema,
  TimeOffIdSchema,
  TimeOffInputSchema,
  TimeOffQuerySchema,
  type StaffMemberId,
  type TimeOff,
  type TimeOffId,
  type TimeOffInput,
  type TimeOffQuery,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, systemClock, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  deleteTimeOff,
  findStaffMember,
  insertTimeOff,
  listTimeOff as listTimeOffRows,
  lockStaffMember,
  withTenant,
  type Database,
  type StaffMemberRecord,
  type TenantTx,
} from '@pepper/db';
import { StaffMemberNotFoundError, TimeOffNotFoundError } from '../errors.js';
import { staffOwner, timeOffAuditValues, toTimeOff } from '../mapping.js';

// Time off (ADR-0015). Everyone in the business may see it (`staff.read`); `time_off.manage`
// lets owners and managers change anyone's and a staff member only their own, i.e. the staff
// member linked to their login.

/** A staff member's time off ending after `from` (default: now), by start. */
export async function listTimeOff(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
  query: TimeOffQuery = {},
  options: { clock?: Clock } = {},
): Promise<TimeOff[]> {
  requirePermission(actor, 'staff.read');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  const { from, limit } = TimeOffQuerySchema.parse(query);
  const since = from === undefined ? (options.clock ?? systemClock).now() : new Date(from);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    if ((await findStaffMember(tx, id)) === undefined) throw new StaffMemberNotFoundError();
    const rows = await listTimeOffRows(tx, id, { from: since, limit });
    return rows.map(toTimeOff);
  });
}

/** Adds time off for a staff member. */
export async function addTimeOff(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
  input: TimeOffInput,
): Promise<TimeOff> {
  // At all first, so a role without it learns nothing about the staff member.
  requirePermission(actor, 'time_off.manage');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  const { startsAt, endsAt } = TimeOffInputSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    await authorise(tx, actor, id);
    const row = await insertTimeOff(tx, {
      staffMemberId: id,
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      createdBy: actor.context.userId,
    });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'time_off.created',
        entity: { type: 'time_off', id: row.id },
        before: null,
        after: timeOffAuditValues(row),
      },
      requestId: actor.requestId,
    });
    return toTimeOff(row);
  });
}

/** Removes a staff member's time-off entry. */
export async function removeTimeOff(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
  timeOffId: TimeOffId,
): Promise<void> {
  requirePermission(actor, 'time_off.manage');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  const entryId = TimeOffIdSchema.parse(timeOffId);
  await withTenant(db, actor.context.tenantId, async (tx) => {
    await authorise(tx, actor, id);
    const row = await deleteTimeOff(tx, id, entryId);
    if (row === undefined) throw new TimeOffNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'time_off.deleted',
        entity: { type: 'time_off', id: row.id },
        before: timeOffAuditValues(row),
        after: null,
      },
      requestId: actor.requestId,
    });
  });
}

/**
 * Locks the staff member and checks the actor may manage their time off: anyone's for owners
 * and managers, their own for staff. The link is read in this transaction, so unlinking a
 * staff member takes effect at once.
 */
async function authorise(
  tx: TenantTx,
  actor: Actor,
  id: StaffMemberId,
): Promise<StaffMemberRecord> {
  const staff = await lockStaffMember(tx, id);
  if (staff === undefined) throw new StaffMemberNotFoundError();
  requirePermission(actor, 'time_off.manage', staffOwner(staff));
  return staff;
}
