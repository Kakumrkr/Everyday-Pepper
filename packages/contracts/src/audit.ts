import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema, WorkingIntervalSchema } from './appointments.js';
import { BookingSourceSchema, BookingStatusSchema } from './bookings.js';
import { ClientIdSchema, RecordSourceSchema } from './clients.js';
import {
  LocaleSchema,
  MembershipRoleSchema,
  TemplateIdSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';
import { RuleSchema } from './rules.js';
import { UtcDateTimeSchema } from './time.js';

// The audit log (ADR-0013): one append-only entry per change to a business, written in the
// same transaction as the change. Each action has a strict schema for its before/after values,
// so an entry holds only the fields listed here: ids, roles and settings, never names, emails,
// phone numbers or free text. New actions are added here, next to the code that writes them.

/** Who made a change: a signed-in member, or the platform itself (jobs, migrations). */
export const AuditActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
]);
export type AuditActor = z.infer<typeof AuditActorSchema>;

const MemberValuesSchema = z.object({ userId: UserIdSchema, role: MembershipRoleSchema }).strict();
const InviteValuesSchema = z.object({ role: MembershipRoleSchema }).strict();

// Appointments base data (ADR-0015). A service's name and category describe the business, not
// a person; a staff member's display name is a person's name, so it is never in an entry.
const ServiceValuesSchema = z
  .object({
    name: z.string(),
    category: z.string().nullable(),
    durationMinutes: z.number().int(),
    bufferBeforeMinutes: z.number().int(),
    bufferAfterMinutes: z.number().int(),
    priceFromCents: z.number().int().nullable(),
    priceToCents: z.number().int().nullable(),
    active: z.boolean(),
  })
  .strict();
const StaffMemberValuesSchema = z
  .object({
    active: z.boolean(),
    userId: UserIdSchema.nullable(),
    serviceIds: z.array(ServiceIdSchema),
  })
  .strict();
const HoursValuesSchema = z.object({ intervals: z.array(WorkingIntervalSchema) }).strict();
const TimeOffValuesSchema = z
  .object({
    staffMemberId: StaffMemberIdSchema,
    startsAt: UtcDateTimeSchema,
    endsAt: UtcDateTimeSchema,
  })
  .strict();

// Booking rules (ADR-0016) hold settings only: durations, counts and dates.
const RulesValuesSchema = z.object({ rules: z.array(RuleSchema) }).strict();

// Clients, bookings and the waitlist (ADR-0017): ids, times and statuses only. A client's name,
// email and phone are personal data and never in an entry.
const ClientValuesSchema = z.object({ source: RecordSourceSchema }).strict();
const BookingValuesSchema = z
  .object({
    clientId: ClientIdSchema,
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema,
    startsAt: UtcDateTimeSchema,
    endsAt: UtcDateTimeSchema,
    status: BookingStatusSchema,
    source: BookingSourceSchema,
    overridden: z.boolean(),
  })
  .strict();
const WaitlistValuesSchema = z
  .object({
    clientId: ClientIdSchema,
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable(),
    expiresAt: UtcDateTimeSchema,
    status: z.enum(['waiting', 'offered', 'booked', 'cancelled']),
  })
  .strict();

function entity<T extends string>(type: T) {
  return z.object({ type: z.literal(type), id: z.uuid() }).strict();
}

/** A change as the code that makes it describes it. */
export const AuditChangeSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('tenant.created'),
      entity: entity('tenant'),
      before: z.null(),
      after: z
        .object({
          slug: TenantSlugSchema,
          timeZone: TimeZoneSchema,
          locale: LocaleSchema,
          // Entries written before S13 have none.
          templateId: TemplateIdSchema.nullable().optional(),
          ownerUserId: UserIdSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('membership.role_changed'),
      entity: entity('membership'),
      before: MemberValuesSchema,
      after: MemberValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('membership.removed'),
      entity: entity('membership'),
      before: MemberValuesSchema,
      after: z.null(),
    })
    .strict(),
  // Invites (ADR-0014): the invitee's email is personal data, so it is never in an entry.
  z
    .object({
      action: z.literal('invite.created'),
      entity: entity('invite'),
      before: z.null(),
      after: InviteValuesSchema.extend({ expiresAt: UtcDateTimeSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('invite.revoked'),
      entity: entity('invite'),
      before: InviteValuesSchema,
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('invite.accepted'),
      entity: entity('invite'),
      before: InviteValuesSchema,
      // The membership the invite created.
      after: MemberValuesSchema.extend({ membershipId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('service.created'),
      entity: entity('service'),
      before: z.null(),
      after: ServiceValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('service.updated'),
      entity: entity('service'),
      before: ServiceValuesSchema,
      after: ServiceValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('staff_member.created'),
      entity: entity('staff_member'),
      before: z.null(),
      after: StaffMemberValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('staff_member.updated'),
      entity: entity('staff_member'),
      before: StaffMemberValuesSchema,
      after: StaffMemberValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('working_hours.replaced'),
      entity: entity('staff_member'),
      before: HoursValuesSchema,
      after: HoursValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('time_off.created'),
      entity: entity('time_off'),
      before: z.null(),
      after: TimeOffValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('time_off.deleted'),
      entity: entity('time_off'),
      before: TimeOffValuesSchema,
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('booking_rules.replaced'),
      entity: entity('tenant'),
      before: RulesValuesSchema,
      after: RulesValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('client.created'),
      entity: entity('client'),
      before: z.null(),
      after: ClientValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('booking.created'),
      entity: entity('booking'),
      before: z.null(),
      after: BookingValuesSchema,
    })
    .strict(),
  // A move (time or staff member) or a status change; `overridden` says whether the new time
  // was booked outside hours or rules.
  z
    .object({
      action: z.literal('booking.updated'),
      entity: entity('booking'),
      before: BookingValuesSchema,
      after: BookingValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('waitlist_entry.created'),
      entity: entity('waitlist_entry'),
      before: z.null(),
      after: WaitlistValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('waitlist_entry.updated'),
      entity: entity('waitlist_entry'),
      before: WaitlistValuesSchema,
      after: WaitlistValuesSchema,
    })
    .strict(),
]);
export type AuditChange = z.infer<typeof AuditChangeSchema>;
export type AuditAction = AuditChange['action'];

/** One entry as `GET /v1/audit-log` returns it. The user is `null` once their account is deleted. */
export const AuditLogEntrySchema = z
  .object({
    id: z.uuid(),
    at: UtcDateTimeSchema,
    actor: z.object({ kind: z.enum(['user', 'system']), userId: UserIdSchema.nullable() }),
  })
  .and(AuditChangeSchema);
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/** Query of `GET /v1/audit-log`: newest first, `limit` per page, entries older than `before`. */
export const AuditLogQuerySchema = z
  .object({
    before: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type AuditLogQuery = z.input<typeof AuditLogQuerySchema>;

export const AuditLogResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  /** Pass as `before` for the next page; `null` on the last page. */
  nextBefore: z.uuid().nullable(),
});
export type AuditLogResponse = z.infer<typeof AuditLogResponseSchema>;
