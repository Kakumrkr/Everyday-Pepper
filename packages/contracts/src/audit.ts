import { z } from 'zod';
import { BusinessExportCountsSchema } from './export.js';
import { ImportCountsSchema, ImportUndoSchema } from './imports.js';
import { ServiceIdSchema, StaffMemberIdSchema, WorkingIntervalSchema } from './appointments.js';
import { BookingOriginSchema, BookingStatusSchema } from './bookings.js';
import { ClientIdSchema, RecordSourceSchema } from './clients.js';
import { FeedSettingsSchema } from './feed.js';
import {
  BrandColorSchema,
  LocaleSchema,
  MembershipRoleSchema,
  TemplateIdSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';
import { BusinessPhotoKindSchema } from './photos.js';
import { MemoryFactStatusSchema, MemorySourceSchema, MemorySubjectTypeSchema } from './memory.js';
import { RuleSchema } from './rules.js';
import { SmsConsentSourceSchema, SmsConsentWordingVersionSchema } from './sms.js';
import { SupportKindSchema, SupportRatingSchema, SupportStatusSchema } from './support.js';
import { TaskSourceSchema, TaskStatusSchema } from './tasks.js';
import {
  ActionProposalIdSchema,
  AutonomyActionSchema,
  AutonomyOutcomeSchema,
  AutonomySettingsSchema,
  ExecutionStatusSchema,
  ProposalStatusSchema,
  UndoReasonSchema,
} from './trust.js';
import { UtcDateTimeSchema } from './time.js';

// The audit log (ADR-0013): one append-only entry per change to a business, written in the
// same transaction as the change. Each action has a strict schema for its before/after values,
// so an entry holds only the fields listed here: ids, roles and settings, never names, emails,
// phone numbers or free text. New actions are added here, next to the code that writes them.

/**
 * Who made a change: a signed-in member, the AI employee acting for a member (ADR-0028: the
 * member asked, or approved its proposal), or the platform itself (jobs, migrations).
 */
export const AuditActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: UserIdSchema }).strict(),
  z.object({ kind: z.literal('ai_on_behalf_of'), userId: UserIdSchema }).strict(),
  z.object({ kind: z.literal('system') }).strict(),
  // The Pepper team in the support console (S59.2, ADR-0062): no person is named to the
  // business; the operator access log holds who it was.
  z.object({ kind: z.literal('operator') }).strict(),
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
/**
 * A business's settings change: the booking page's color (ADR-0022), or whether rebooking
 * emails have a mailing address (S36; never the address itself, which may be a home).
 */
const TenantChangeSchema = z.union([
  z.object({ brandColor: BrandColorSchema.nullable() }).strict(),
  z.object({ mailingAddressSet: z.boolean() }).strict(),
  // Whether review requests have a link (S55.2): only set or not, like the address.
  z.object({ reviewUrlSet: z.boolean() }).strict(),
  // Home's setup review (S46): only that it was checked.
  z.object({ setupReviewed: z.boolean() }).strict(),
  // The booking page's profile (S47): which fields changed, never their values (a home
  // address or a personal phone is someone's), with the color's value when it changed too.
  z
    .object({
      brandColor: BrandColorSchema.nullable().optional(),
      profileChanged: z
        .array(z.enum(['phone', 'publicAddress', 'cancellationPolicy']))
        .min(1)
        .max(3),
    })
    .strict(),
]);

/** Where a new client came from; `walkIn` when staff added them with their booking (S50.2). */
const ClientValuesSchema = z
  .object({ source: RecordSourceSchema, walkIn: z.literal(true).optional() })
  .strict();
/** Which of a client's details an edit changed (never the values). */
const ClientEditSchema = z
  .object({
    changed: z
      .array(z.enum(['name', 'email', 'phone', 'tags', 'birthday']))
      .min(1)
      .max(5),
  })
  .strict();
const RecordCount = z.number().int().min(0);
/** A merge (S50, ADR-0051): the client merged in (now gone) and what moved, as counts. */
const ClientMergedSchema = z
  .object({
    mergedClientId: ClientIdSchema,
    moved: z
      .object({ visits: RecordCount, waitlistEntries: RecordCount, notes: RecordCount })
      .strict(),
  })
  .strict();
/** A deletion (S50, ADR-0051): what stayed and what was forgotten, as counts; no details. */
const ClientDeletedSchema = z
  .object({ pastVisitsKept: RecordCount, notesForgotten: RecordCount })
  .strict();
const BookingValuesSchema = z
  .object({
    clientId: ClientIdSchema,
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema,
    startsAt: UtcDateTimeSchema,
    endsAt: UtcDateTimeSchema,
    status: BookingStatusSchema,
    source: BookingOriginSchema,
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

// A task's title is free text a member typed, so it is never in an entry (ADR-0026).
const TaskValuesSchema = z
  .object({
    status: TaskStatusSchema,
    dueAt: UtcDateTimeSchema.nullable(),
    assigneeUserId: UserIdSchema.nullable(),
    source: TaskSourceSchema,
  })
  .strict();

// What Pepper remembers (ADR-0034): a fact's subject type, key and flags, never its value or
// whom it is about (the value is free text; deleting it must leave nothing behind).
const MemoryFactValuesSchema = z
  .object({
    subjectType: MemorySubjectTypeSchema,
    key: z.string(),
    sensitive: z.boolean(),
    status: MemoryFactStatusSchema,
    source: MemorySourceSchema,
  })
  .strict();

// The trust layer (ADR-0028): autonomy settings, and the AI's proposals and executions by
// action, status and time. Payloads, previews and explanations stay in their own tables.
const AutonomyValuesSchema = z
  .object({
    askFirst: z.boolean(),
    levels: AutonomySettingsSchema,
  })
  .strict();
const ProposalValuesSchema = z
  .object({ action: AutonomyActionSchema, status: ProposalStatusSchema })
  .strict();
const ExecutionValuesSchema = z
  .object({
    action: AutonomyActionSchema,
    outcome: AutonomyOutcomeSchema,
    status: ExecutionStatusSchema,
    proposalId: ActionProposalIdSchema.nullable(),
    undoUntil: UtcDateTimeSchema.nullable(),
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
  // The booking page's settings (ADR-0022).
  z
    .object({
      action: z.literal('tenant.updated'),
      entity: entity('tenant'),
      before: TenantChangeSchema,
      after: TenantChangeSchema,
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
      action: z.literal('client.updated'),
      entity: entity('client'),
      before: z.null(),
      after: ClientEditSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('client.merged'),
      entity: entity('client'),
      before: z.null(),
      after: ClientMergedSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('client.deleted'),
      entity: entity('client'),
      before: z.null(),
      after: ClientDeletedSchema,
    })
    .strict(),
  // The client unsubscribed from marketing email with the one-click link (S36): no address.
  z
    .object({
      action: z.literal('client.email_opted_out'),
      entity: entity('client'),
      before: z.object({ emailOptedOut: z.literal(false) }).strict(),
      after: z.object({ emailOptedOut: z.literal(true) }).strict(),
    })
    .strict(),
  // An SMS consent recorded or revoked (S61, ADR-0065 §7): how and which wording, no number.
  z
    .object({
      action: z.literal('sms.consent_given'),
      entity: entity('sms_consent'),
      before: z.null(),
      after: z
        .object({
          source: SmsConsentSourceSchema,
          wordingVersion: SmsConsentWordingVersionSchema,
          clientId: ClientIdSchema.nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('sms.consent_revoked'),
      entity: entity('sms_consent'),
      before: z.object({ active: z.literal(true) }).strict(),
      after: z.object({ active: z.literal(false) }).strict(),
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
  z
    .object({
      action: z.literal('task.created'),
      entity: entity('task'),
      before: z.null(),
      after: TaskValuesSchema,
    })
    .strict(),
  // A changed title alone is recorded as a change with equal values.
  z
    .object({
      action: z.literal('task.updated'),
      entity: entity('task'),
      before: TaskValuesSchema,
      after: TaskValuesSchema,
    })
    .strict(),
  // A to-do the AI added, taken back by Undo (ADR-0028) before anyone worked on it.
  z
    .object({
      action: z.literal('task.deleted'),
      entity: entity('task'),
      before: TaskValuesSchema,
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('memory_fact.created'),
      entity: entity('memory_fact'),
      before: z.null(),
      after: MemoryFactValuesSchema,
    })
    .strict(),
  // A new value is recorded as a change with equal fields (the values are never in an entry).
  z
    .object({
      action: z.literal('memory_fact.updated'),
      entity: entity('memory_fact'),
      before: MemoryFactValuesSchema,
      after: MemoryFactValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('memory_fact.deleted'),
      entity: entity('memory_fact'),
      before: MemoryFactValuesSchema,
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('memory_episode.created'),
      entity: entity('memory_episode'),
      before: z.null(),
      after: z.object({ clientCount: z.number().int().min(0) }).strict(),
    })
    .strict(),
  // A conversation that continued gets a new summary in place of its old one (S31).
  z
    .object({
      action: z.literal('memory_episode.replaced'),
      entity: entity('memory_episode'),
      before: z.object({ clientCount: z.number().int().min(0) }).strict(),
      after: z.object({ clientCount: z.number().int().min(0) }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('memory_episode.deleted'),
      entity: entity('memory_episode'),
      before: z.object({ clientCount: z.number().int().min(0) }).strict(),
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('memory.settings_updated'),
      entity: entity('tenant'),
      before: z.object({ paused: z.boolean() }).strict(),
      after: z.object({ paused: z.boolean() }).strict(),
    })
    .strict(),
  // Booking page photos (S47.2, ADR-0048): the kind only; a caption is the owner's free text.
  z
    .object({
      action: z.literal('business_photo.added'),
      entity: entity('business_photo'),
      before: z.null(),
      after: z.object({ kind: BusinessPhotoKindSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('business_photo.updated'),
      entity: entity('business_photo'),
      before: z.object({ captioned: z.boolean() }).strict(),
      after: z.object({ captioned: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('business_photo.removed'),
      entity: entity('business_photo'),
      before: z.object({ kind: BusinessPhotoKindSchema }).strict(),
      after: z.null(),
    })
    .strict(),
  // The operator feed's switches (ADR-0039).
  z
    .object({
      action: z.literal('feed.settings_updated'),
      entity: entity('tenant'),
      before: FeedSettingsSchema,
      after: FeedSettingsSchema,
    })
    .strict(),
  // The business's own autonomy choices (only the overrides; the rest are defaults).
  z
    .object({
      action: z.literal('autonomy.updated'),
      entity: entity('tenant'),
      before: AutonomyValuesSchema,
      after: AutonomyValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('ai_proposal.created'),
      entity: entity('ai_action_proposal'),
      before: z.null(),
      after: ProposalValuesSchema.extend({ expiresAt: UtcDateTimeSchema }).strict(),
    })
    .strict(),
  // Approved, rejected, expired or superseded.
  z
    .object({
      action: z.literal('ai_proposal.decided'),
      entity: entity('ai_action_proposal'),
      before: ProposalValuesSchema,
      after: ProposalValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('ai_action.executed'),
      entity: entity('ai_action_execution'),
      before: z.null(),
      after: ExecutionValuesSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('ai_action.undone'),
      entity: entity('ai_action_execution'),
      before: ExecutionValuesSchema,
      after: ExecutionValuesSchema.extend({ undoReason: UndoReasonSchema.nullable() }).strict(),
    })
    .strict(),
  // The owner downloaded the business's data (S51, ADR-0053): counts only.
  z
    .object({
      action: z.literal('business.exported'),
      entity: entity('tenant'),
      before: z.null(),
      after: BusinessExportCountsSchema,
    })
    .strict(),
  // The owner asked for the business to be deleted, or kept it (S51.2, ADR-0054). The
  // deletion itself leaves no entry: the audit log goes with the business.
  z
    .object({
      action: z.literal('business.deletion_scheduled'),
      entity: entity('tenant'),
      before: z.null(),
      after: z.object({ dueAt: UtcDateTimeSchema }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('business.deletion_cancelled'),
      entity: entity('tenant'),
      before: z.object({ dueAt: UtcDateTimeSchema }).strict(),
      after: z.null(),
    })
    .strict(),
  // Client imports (S48, ADR-0049): counts only, never a client's details.
  z
    .object({
      action: z.literal('client_import.committed'),
      entity: entity('client_import'),
      before: z.null(),
      after: z.object({ rows: z.number().int().nonnegative() }).strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('client_import.finished'),
      entity: entity('client_import'),
      before: z.null(),
      after: ImportCountsSchema.omit({ rows: true })
        .extend({ status: z.enum(['done', 'failed']) })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('client_import.undone'),
      entity: entity('client_import'),
      before: z.null(),
      after: ImportUndoSchema.strict(),
    })
    .strict(),
  // Support requests (S59, PCR-010, AC-X-15): the kind and the status only, never the text.
  z
    .object({
      action: z.literal('support_thread.opened'),
      entity: entity('support_thread'),
      before: z.null(),
      // `channel: 'email'`: a follow-up an emailed reply opened (S59.3, AC-X-37).
      after: z
        .object({
          kind: SupportKindSchema,
          status: SupportStatusSchema,
          channel: z.literal('email').optional(),
        })
        .strict(),
    })
    .strict(),
  // A reply by a member (`user`) or by the Pepper team (`system`), with the status it led to.
  z
    .object({
      action: z.literal('support_thread.replied'),
      entity: entity('support_thread'),
      before: z.object({ status: SupportStatusSchema }).strict(),
      // `channel: 'email'`: the member's emailed reply (S59.3, AC-X-34).
      after: z
        .object({ status: SupportStatusSchema, channel: z.literal('email').optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      action: z.literal('support_thread.solved'),
      entity: entity('support_thread'),
      before: z.object({ status: SupportStatusSchema }).strict(),
      after: z.object({ status: z.literal('solved') }).strict(),
    })
    .strict(),
  // The Pepper team opened a request (S59.2, AC-X-22), or moved it to any status.
  z
    .object({
      action: z.literal('support_thread.seen'),
      entity: entity('support_thread'),
      before: z.null(),
      after: z.null(),
    })
    .strict(),
  z
    .object({
      action: z.literal('support_thread.status_changed'),
      entity: entity('support_thread'),
      before: z.object({ status: SupportStatusSchema }).strict(),
      after: z.object({ status: SupportStatusSchema }).strict(),
    })
    .strict(),
  // The opener's "Did this help?" (S59.2.2, AC-X-26): the answer only.
  z
    .object({
      action: z.literal('support_thread.rated'),
      entity: entity('support_thread'),
      before: z.object({ rating: SupportRatingSchema.nullable() }).strict(),
      after: z.object({ rating: SupportRatingSchema }).strict(),
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
    actor: z.object({
      kind: z.enum(['user', 'ai_on_behalf_of', 'system', 'operator']),
      userId: UserIdSchema.nullable(),
    }),
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
