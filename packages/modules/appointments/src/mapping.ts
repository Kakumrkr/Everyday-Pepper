import {
  BookingRulesSchema,
  clockTime,
  minutesOfDay,
  ServiceSchema,
  StaffMemberSchema,
  TimeOffSchema,
  UserIdSchema,
  WeeklyHoursSchema,
  type AuditChange,
  type BookingRules,
  type Service,
  type StaffMember,
  type TimeOff,
  type WeeklyHours,
} from '@floty/contracts';
import type { OwnedRecord } from '@floty/core';
import type {
  BookingRuleRow,
  ServiceRow,
  StaffMemberRecord,
  TimeOffRow,
  WorkingMinutes,
} from '@floty/db';

// Between database rows and the api's shapes (ADR-0015), and what the audit log keeps of each.

type Values<A extends AuditChange['action']> = NonNullable<
  Extract<AuditChange, { action: A }>['after']
>;

export function toService(row: ServiceRow): Service {
  return ServiceSchema.parse({
    ...serviceAuditValues(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/** A service's fields for the audit log (a service describes the business, not a person). */
export function serviceAuditValues(row: ServiceRow): Values<'service.created'> {
  return {
    name: row.name,
    category: row.category,
    durationMinutes: row.durationMinutes,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    priceFromCents: row.priceFromCents,
    priceToCents: row.priceToCents,
    active: row.active,
  };
}

export function toStaffMember(record: StaffMemberRecord): StaffMember {
  return StaffMemberSchema.parse({
    ...staffAuditValues(record),
    id: record.id,
    displayName: record.displayName,
    color: record.color,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  });
}

/** A staff member's fields for the audit log: no display name (it is a person's name). */
export function staffAuditValues(record: StaffMemberRecord): Values<'staff_member.created'> {
  return {
    active: record.active,
    userId: record.userId === null ? null : UserIdSchema.parse(record.userId),
    serviceIds: StaffMemberSchema.shape.serviceIds.parse(record.serviceIds),
  };
}

/** Whose records a staff member's time off is, for the permission check: their linked user's. */
export function staffOwner(record: StaffMemberRecord): OwnedRecord {
  return { ownerUserId: record.userId === null ? null : UserIdSchema.parse(record.userId) };
}

/** Weekly hours as stored: minutes after local midnight. */
export function hoursToMinutes(hours: WeeklyHours): WorkingMinutes[] {
  return hours.intervals.map((interval) => ({
    weekday: interval.weekday,
    startMinute: minutesOfDay(interval.start),
    endMinute: minutesOfDay(interval.end),
  }));
}

/** Weekly hours as the api returns them, from stored minutes. */
export function minutesToHours(rows: readonly WorkingMinutes[]): WeeklyHours {
  return WeeklyHoursSchema.parse({
    intervals: rows.map((row) => ({
      weekday: row.weekday,
      start: clockTime(row.startMinute),
      end: clockTime(row.endMinute),
    })),
  });
}

export function toTimeOff(row: TimeOffRow): TimeOff {
  return TimeOffSchema.parse({
    ...timeOffAuditValues(row),
    id: row.id,
    createdAt: row.createdAt.toISOString(),
  });
}

/** A time-off entry for the audit log: whose and when (no reason is ever stored). */
export function timeOffAuditValues(row: TimeOffRow): Values<'time_off.created'> {
  return TimeOffSchema.pick({ staffMemberId: true, startsAt: true, endsAt: true }).parse({
    staffMemberId: row.staffMemberId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
  });
}

/**
 * Stored rules as the api returns them, validated and sorted. A row the contracts reject (a
 * version this code does not know) fails loudly rather than being ignored.
 */
export function rowsToRules(rows: readonly BookingRuleRow[]): BookingRules {
  return BookingRulesSchema.parse({
    rules: rows.map((row) => ({
      type: row.type,
      version: row.version,
      staffMemberId: row.staffMemberId,
      params: row.params,
    })),
  });
}

/** Whether two audit values describe the same state (an unchanged update is not audited). */
export function sameValues(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
