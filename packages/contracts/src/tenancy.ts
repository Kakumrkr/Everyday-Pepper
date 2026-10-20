import { z } from 'zod';

/**
 * A tenant (business) id: a UUID, lowercased so ids compare equal as strings (Postgres prints
 * them lowercase). It comes from the authenticated session only, never from request bodies or
 * LLM arguments (CLAUDE.md "Tenant isolation").
 */
export const TenantIdSchema = z.uuid().toLowerCase().brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantIdSchema>;

/** A user id: a lowercased UUID. Users are global; a membership links one to a tenant. */
export const UserIdSchema = z.uuid().toLowerCase().brand<'UserId'>();
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

/**
 * The booking page's color (PCR-001): `#rrggbb`, stored lowercased. The page derives its
 * colors from it and adjusts them until text on them passes WCAG AA (`@pepper/ui`).
 */
export const BrandColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^#[0-9a-f]{6}$/, 'Use a color such as #7a3e6c');
export type BrandColor = z.infer<typeof BrandColorSchema>;

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

/** A member's role in a tenant; what each role may do is the permission matrix in core. */
export const MembershipRoleSchema = z.enum(['owner', 'manager', 'staff']);
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;

/**
 * The industry template a business starts from (ADR-0018); the templates themselves are in
 * `templates.ts` and `@pepper/templates`. V1: Beauty and Wellness & fitness (v1-scope.md).
 */
export const TemplateIdSchema = z.enum([
  'beauty-salon',
  'barber',
  'nails',
  'spa',
  'lash-brow',
  'personal-trainer',
  'massage',
  'yoga-pilates-private',
]);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

/** Input for creating a tenant (business); no template: platform defaults only. */
export const NewTenantSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: TenantSlugSchema,
  timeZone: TimeZoneSchema,
  locale: LocaleSchema.default('en-US'),
  templateId: TemplateIdSchema.nullable().default(null),
});
export type NewTenant = z.input<typeof NewTenantSchema>;
