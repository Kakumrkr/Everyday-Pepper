import {
  ServiceInputSchema,
  StaffColorSchema,
  type Rule,
  type ServiceFields,
  type ServiceId,
  type StaffMemberId,
  type TimeOffId,
  type UserId,
} from '@floty/contracts';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isUniqueViolation, ServiceNameTakenError, StaffMemberLinkTakenError } from '../errors.js';
import {
  bookingRules,
  memberships,
  services,
  staffMembers,
  staffServices,
  timeOff,
  workingHours,
  type BookingRuleRow,
  type ServiceRow,
  type StaffMemberRow,
  type TimeOffRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The appointments base data of the transaction's tenant (ADR-0015). Every function runs inside
// `withTenant`: `tenant_id` defaults to the transaction's tenant and RLS hides other tenants'
// rows, so ids from another business are simply not found.

const Id = z.uuid();

// Services ----------------------------------------------------------------------------------

/** The tenant's services, by name. */
export async function listServices(tx: TenantTx): Promise<ServiceRow[]> {
  return tx
    .select()
    .from(services)
    .orderBy(asc(sql`lower(${services.name})`), asc(services.id));
}

/** The service with this id. */
export async function findService(tx: TenantTx, id: ServiceId): Promise<ServiceRow | undefined> {
  const [row] = await tx
    .select()
    .from(services)
    .where(eq(services.id, Id.parse(id)));
  return row;
}

/** The service with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockService(tx: TenantTx, id: ServiceId): Promise<ServiceRow | undefined> {
  const [row] = await tx
    .select()
    .from(services)
    .where(eq(services.id, Id.parse(id)))
    .for('update');
  return row;
}

/** Throws `ServiceNameTakenError` when the business has a service with this name. */
export async function insertService(tx: TenantTx, fields: ServiceFields): Promise<ServiceRow> {
  const values = ServiceInputSchema.parse(fields);
  return serviceNameUnique(async () => {
    const [row] = await tx.insert(services).values(values).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return row!;
  });
}

/** Replaces a service's fields; `undefined` when there is no such service. */
export async function updateService(
  tx: TenantTx,
  id: ServiceId,
  fields: ServiceFields,
): Promise<ServiceRow | undefined> {
  const values = ServiceInputSchema.parse(fields);
  return serviceNameUnique(async () => {
    const [row] = await tx
      .update(services)
      .set(values)
      .where(eq(services.id, Id.parse(id)))
      .returning();
    return row;
  });
}

/** Of `ids`, the ones that are services of the tenant. */
export async function findServiceIds(tx: TenantTx, ids: readonly ServiceId[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: services.id })
    .from(services)
    .where(
      inArray(
        services.id,
        ids.map((id) => Id.parse(id)),
      ),
    );
  return rows.map((row) => row.id);
}

async function serviceNameUnique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, 'services_tenant_name_unique')) {
      throw new ServiceNameTakenError({ cause: error });
    }
    throw error;
  }
}

// Staff members -----------------------------------------------------------------------------

/** A staff member with the user of their linked membership and the services they offer. */
export interface StaffMemberRecord extends StaffMemberRow {
  /** The linked member's user; `null` when not linked. */
  userId: string | null;
  /** Sorted. */
  serviceIds: string[];
}

export interface StaffMemberValues {
  displayName: string;
  color: string;
  active: boolean;
  /** The membership to link (from `findMembership`), or `null`. */
  membershipId: string | null;
}

const StaffMemberValuesSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  color: StaffColorSchema,
  active: z.boolean(),
  membershipId: Id.nullable(),
});

/** The tenant's staff members, by name. */
export async function listStaffMembers(tx: TenantTx): Promise<StaffMemberRecord[]> {
  const rows = await selectStaff(tx).orderBy(
    asc(sql`lower(${staffMembers.displayName})`),
    asc(staffMembers.id),
  );
  return withServices(tx, rows);
}

/** The staff member with this id. */
export async function findStaffMember(
  tx: TenantTx,
  id: StaffMemberId,
): Promise<StaffMemberRecord | undefined> {
  const rows = await selectStaff(tx).where(eq(staffMembers.id, Id.parse(id)));
  return (await withServices(tx, rows))[0];
}

/** The staff member with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockStaffMember(
  tx: TenantTx,
  id: StaffMemberId,
): Promise<StaffMemberRecord | undefined> {
  const rows = await selectStaff(tx)
    .where(eq(staffMembers.id, Id.parse(id)))
    .for('update', { of: staffMembers });
  return (await withServices(tx, rows))[0];
}

/** The staff member linked to `userId`'s membership, if any. */
export async function findStaffMemberOfUser(
  tx: TenantTx,
  userId: UserId,
): Promise<StaffMemberRecord | undefined> {
  const rows = await selectStaff(tx).where(eq(memberships.userId, Id.parse(userId)));
  return (await withServices(tx, rows))[0];
}

/** Throws `StaffMemberLinkTakenError` when the membership is linked to another staff member. */
export async function insertStaffMember(
  tx: TenantTx,
  values: StaffMemberValues,
): Promise<StaffMemberRow> {
  const parsed = StaffMemberValuesSchema.parse(values);
  return staffLinkUnique(async () => {
    const [row] = await tx.insert(staffMembers).values(parsed).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return row!;
  });
}

/** Replaces a staff member's fields; `undefined` when there is no such staff member. */
export async function updateStaffMember(
  tx: TenantTx,
  id: StaffMemberId,
  values: StaffMemberValues,
): Promise<StaffMemberRow | undefined> {
  const parsed = StaffMemberValuesSchema.parse(values);
  return staffLinkUnique(async () => {
    const [row] = await tx
      .update(staffMembers)
      .set(parsed)
      .where(eq(staffMembers.id, Id.parse(id)))
      .returning();
    return row;
  });
}

/** Sets the services a staff member offers to exactly `serviceIds`. */
export async function replaceStaffServices(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  serviceIds: readonly ServiceId[],
): Promise<void> {
  const staffId = Id.parse(staffMemberId);
  await tx.delete(staffServices).where(eq(staffServices.staffMemberId, staffId));
  if (serviceIds.length === 0) return;
  await tx
    .insert(staffServices)
    .values(
      serviceIds.map((serviceId) => ({ staffMemberId: staffId, serviceId: Id.parse(serviceId) })),
    );
}

function selectStaff(tx: TenantTx) {
  const { id, tenantId, displayName, color, active, membershipId, createdAt, updatedAt } =
    staffMembers;
  return tx
    .select({
      id,
      tenantId,
      displayName,
      color,
      active,
      membershipId,
      createdAt,
      updatedAt,
      userId: memberships.userId,
    })
    .from(staffMembers)
    .leftJoin(memberships, eq(memberships.id, staffMembers.membershipId))
    .$dynamic();
}

async function withServices(
  tx: TenantTx,
  rows: (StaffMemberRow & { userId: string | null })[],
): Promise<StaffMemberRecord[]> {
  if (rows.length === 0) return [];
  const links = await tx
    .select({ staffMemberId: staffServices.staffMemberId, serviceId: staffServices.serviceId })
    .from(staffServices)
    .where(
      inArray(
        staffServices.staffMemberId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(staffServices.serviceId));
  return rows.map((row) => ({
    ...row,
    serviceIds: links.filter((l) => l.staffMemberId === row.id).map((l) => l.serviceId),
  }));
}

async function staffLinkUnique<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error, 'staff_members_membership_id_unique')) {
      throw new StaffMemberLinkTakenError({ cause: error });
    }
    throw error;
  }
}

// Working hours -----------------------------------------------------------------------------

/** One weekly working interval in minutes after local midnight. */
export interface WorkingMinutes {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

/** A staff member's weekly working intervals, by weekday and start. */
export async function listWorkingHours(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
): Promise<WorkingMinutes[]> {
  return tx
    .select({
      weekday: workingHours.weekday,
      startMinute: workingHours.startMinute,
      endMinute: workingHours.endMinute,
    })
    .from(workingHours)
    .where(eq(workingHours.staffMemberId, Id.parse(staffMemberId)))
    .orderBy(asc(workingHours.weekday), asc(workingHours.startMinute));
}

/** Replaces a staff member's whole week with `intervals`. */
export async function replaceWorkingHours(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  intervals: readonly WorkingMinutes[],
): Promise<void> {
  const staffId = Id.parse(staffMemberId);
  await tx.delete(workingHours).where(eq(workingHours.staffMemberId, staffId));
  if (intervals.length === 0) return;
  await tx
    .insert(workingHours)
    .values(intervals.map((interval) => ({ ...interval, staffMemberId: staffId })));
}

// Time off ----------------------------------------------------------------------------------

export interface NewTimeOff {
  staffMemberId: StaffMemberId;
  startsAt: Date;
  endsAt: Date;
  createdBy: UserId;
}

export async function insertTimeOff(tx: TenantTx, input: NewTimeOff): Promise<TimeOffRow> {
  const [row] = await tx
    .insert(timeOff)
    .values({
      staffMemberId: Id.parse(input.staffMemberId),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      createdByUserId: Id.parse(input.createdBy),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** A staff member's time off that ends after `from`, by start, at most `limit` entries. */
export async function listTimeOff(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  options: { from: Date; limit: number },
): Promise<TimeOffRow[]> {
  return tx
    .select()
    .from(timeOff)
    .where(
      and(eq(timeOff.staffMemberId, Id.parse(staffMemberId)), gt(timeOff.endsAt, options.from)),
    )
    .orderBy(asc(timeOff.startsAt), asc(timeOff.id))
    .limit(options.limit);
}

/** Deletes a staff member's time-off entry; returns it, or `undefined` if there was none. */
export async function deleteTimeOff(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  id: TimeOffId,
): Promise<TimeOffRow | undefined> {
  const [row] = await tx
    .delete(timeOff)
    .where(and(eq(timeOff.id, Id.parse(id)), eq(timeOff.staffMemberId, Id.parse(staffMemberId))))
    .returning();
  return row;
}

// Booking rules (ADR-0016) -------------------------------------------------------------------

/** The tenant's booking rules as stored; the appointments module validates their params. */
export async function listBookingRules(tx: TenantTx): Promise<BookingRuleRow[]> {
  return tx.select().from(bookingRules).orderBy(asc(bookingRules.createdAt), asc(bookingRules.id));
}

/**
 * Serialises changes to the tenant's rule set until the transaction ends (an advisory lock:
 * the set may be empty, so there is no row to lock).
 */
export async function lockBookingRules(tx: TenantTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended('floty.booking_rules:' || current_tenant_id()::text, 0))`,
  );
}

/** Which of `ids` are staff members of the tenant. */
export async function findStaffMemberIds(
  tx: TenantTx,
  ids: readonly StaffMemberId[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .where(
      inArray(
        staffMembers.id,
        ids.map((id) => Id.parse(id)),
      ),
    );
  return rows.map((row) => row.id);
}

/** Replaces the tenant's whole rule set. */
export async function replaceBookingRules(tx: TenantTx, rules: readonly Rule[]): Promise<void> {
  // RLS already limits this to the tenant; the condition keeps it so without RLS too.
  await tx.delete(bookingRules).where(sql`${bookingRules.tenantId} = current_tenant_id()`);
  if (rules.length === 0) return;
  await tx.insert(bookingRules).values(
    rules.map((rule) => ({
      staffMemberId: rule.staffMemberId === null ? null : Id.parse(rule.staffMemberId),
      type: rule.type,
      version: rule.version,
      params: rule.params,
    })),
  );
}

// Availability inputs (ADR-0016, ADR-0017) -------------------------------------------------

/** Weekly working intervals of several staff members, by staff member, weekday and start. */
export async function listWorkingHoursOf(
  tx: TenantTx,
  staffMemberIds: readonly StaffMemberId[],
): Promise<(WorkingMinutes & { staffMemberId: string })[]> {
  if (staffMemberIds.length === 0) return [];
  return tx
    .select({
      staffMemberId: workingHours.staffMemberId,
      weekday: workingHours.weekday,
      startMinute: workingHours.startMinute,
      endMinute: workingHours.endMinute,
    })
    .from(workingHours)
    .where(
      inArray(
        workingHours.staffMemberId,
        staffMemberIds.map((id) => Id.parse(id)),
      ),
    )
    .orderBy(
      asc(workingHours.staffMemberId),
      asc(workingHours.weekday),
      asc(workingHours.startMinute),
    );
}

/** Time off of several staff members that overlaps [from, to), by start. */
export async function listTimeOffBetween(
  tx: TenantTx,
  staffMemberIds: readonly StaffMemberId[],
  range: { from: Date; to: Date },
): Promise<TimeOffRow[]> {
  if (staffMemberIds.length === 0) return [];
  return tx
    .select()
    .from(timeOff)
    .where(
      and(
        inArray(
          timeOff.staffMemberId,
          staffMemberIds.map((id) => Id.parse(id)),
        ),
        lt(timeOff.startsAt, range.to),
        gt(timeOff.endsAt, range.from),
      ),
    )
    .orderBy(asc(timeOff.startsAt), asc(timeOff.id));
}
