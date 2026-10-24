import {
  StaffMemberIdSchema,
  WeeklyHoursSchema,
  type StaffMemberId,
  type WeeklyHours,
  type WeeklyHoursInput,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  findStaffMember,
  listWorkingHours,
  lockStaffMember,
  replaceWorkingHours as replaceWorkingHourRows,
  withTenant,
  type Database,
} from '@pepper/db';
import { StaffMemberNotFoundError } from '../errors.js';
import { hoursToMinutes, minutesToHours, sameValues } from '../mapping.js';
import { requestInsights } from './insights.js';

// A staff member's weekly working hours, in the business's local time (ADR-0015). Everyone in
// the business may read them (`staff.read`); changing them needs `hours.manage` (owners and
// managers, not the staff member themselves).

/** A staff member's weekly hours. */
export async function getWorkingHours(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
): Promise<WeeklyHours> {
  requirePermission(actor, 'staff.read');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    if ((await findStaffMember(tx, id)) === undefined) throw new StaffMemberNotFoundError();
    return minutesToHours(await listWorkingHours(tx, id));
  });
}

/** Replaces a staff member's whole week; an unchanged week is not audited. */
export async function replaceWorkingHours(
  db: Database,
  actor: Actor,
  staffMemberId: StaffMemberId,
  input: WeeklyHoursInput,
): Promise<WeeklyHours> {
  requirePermission(actor, 'hours.manage');
  const id = StaffMemberIdSchema.parse(staffMemberId);
  const hours = WeeklyHoursSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    // Locking the staff member serialises concurrent changes to their week.
    if ((await lockStaffMember(tx, id)) === undefined) throw new StaffMemberNotFoundError();
    const before = minutesToHours(await listWorkingHours(tx, id));
    await replaceWorkingHourRows(tx, id, hoursToMinutes(hours));
    const after = minutesToHours(await listWorkingHours(tx, id));
    if (!sameValues(before, after)) {
      // New hours open or close gaps: the feed is computed again soon (ADR-0039).
      await requestInsights(tx);
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'working_hours.replaced',
          entity: { type: 'staff_member', id },
          before,
          after,
        },
        requestId: actor.requestId,
      });
    }
    return after;
  });
}
