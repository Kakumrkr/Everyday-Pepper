import { z } from 'zod';

/**
 * A tenant (business) id: a UUID. It comes from the authenticated session only, never from
 * request bodies or LLM arguments (CLAUDE.md "Tenant isolation").
 */
export const TenantIdSchema = z.uuid().brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantIdSchema>;

/** A user id: a UUID. Users are global; a membership links one to a tenant. */
export const UserIdSchema = z.uuid().brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

/**
 * The business's public handle, used in the booking page URL: lowercase letters, digits and
 * single hyphens, 3–63 characters, starting with a letter.
 */
export const TenantSlugSchema = z
  .string()
  .regex(
    /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/,
    'Use 3–63 lowercase letters, digits or hyphens',
  );
export type TenantSlug = z.infer<typeof TenantSlugSchema>;

/** An IANA time zone the runtime knows, e.g. `America/New_York`. */
export const TimeZoneSchema = z.string().refine(isKnownTimeZone, 'Unknown IANA time zone');

function isKnownTimeZone(value: string): boolean {
  if (!/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A BCP 47 locale tag such as `en-US`. */
export const LocaleSchema = z.string().refine((value) => {
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}, 'Use a canonical BCP 47 locale such as en-US');

/** What a member may do in a tenant; the permission matrix lives in core (Phase 2c). */
export const MembershipRoleSchema = z.enum(['owner', 'manager', 'staff']);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

/** Input for creating a tenant (business). */
export const NewTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: TenantSlugSchema,
  timeZone: TimeZoneSchema,
  locale: LocaleSchema.default('en-US'),
});
export type NewTenant = z.input<typeof NewTenantSchema>;
