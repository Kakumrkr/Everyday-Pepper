import { z } from 'zod';
import {
  LocaleSchema,
  MembershipRoleSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';
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
