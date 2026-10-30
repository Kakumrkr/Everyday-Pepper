import { z } from 'zod';
import { MailingAddressSchema } from './drafts.js';
import { PermissionSchema } from './permissions.js';
import {
  BrandColorSchema,
  LocaleSchema,
  MembershipRoleSchema,
  TenantIdSchema,
  TemplateIdSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// The signed-in user's account and businesses: bodies of the api's `/v1/me` and `/v1/tenant`
// endpoints (ADR-0012). Sign-up, sign-in and second factor go through Better Auth's own
// `/api/auth/*` endpoints.

/** Error body of the api's own endpoints: a stable code for the UI and a human message. */
export const ApiErrorCodeSchema = z.enum([
  'unauthenticated',
  'no_active_tenant',
  'not_a_member',
  'mfa_required',
  'forbidden_origin',
  'slug_taken',
  'validation_failed',
  'forbidden',
  'member_not_found',
  'last_owner',
  'business_limit_reached',
  'invite_invalid',
  'invite_wrong_account',
  'invite_not_found',
  'invite_limit_reached',
  'already_a_member',
  'service_not_found',
  'service_name_taken',
  'staff_member_not_found',
  'staff_member_link_taken',
  'time_off_not_found',
  'client_not_found',
  'client_email_taken',
  'booking_not_found',
  'slot_unavailable',
  'booking_not_changeable',
  'booking_not_started',
  'idempotency_key_reused',
  'waitlist_entry_not_found',
  'waitlist_entry_not_changeable',
  'waitlist_expired',
  'waitlist_times_free',
  'waitlist_day_too_far',
  // Waitlist offers (S37, ADR-0041).
  'waitlist_offer_not_found',
  'waitlist_offer_used',
  'waitlist_offer_taken',
  'waitlist_offer_expired',
  // To-dos (ADR-0026).
  'task_not_found',
  'task_assignee_not_member',
  'push_unavailable',
  // The operator feed (ADR-0039).
  'feed_item_not_found',
  // Rebooking emails (S36, ADR-0040).
  'draft_refused',
  'nudge_not_sendable',
  'unsubscribe_link_invalid',
  // The public booking page (ADR-0022).
  'booking_page_not_found',
  'booking_request_not_found',
  'booking_request_expired',
  'booking_request_used',
  'wrong_code',
  'too_many_requests',
  'email_unavailable',
  'temporarily_unavailable',
  // Chat with the AI (ADR-0030).
  'conversation_not_found',
  'turn_in_progress',
  // The AI's proposals and actions (ADR-0031).
  'proposal_not_found',
  'proposal_not_pending',
  'action_not_found',
  'undo_window_closed',
  'undo_refused',
  // What Pepper remembers (ADR-0034, ADR-0038).
  'memory_fact_not_found',
  'memory_subject_not_found',
  'memory_episode_not_found',
  'memory_limit_reached',
  'memory_paused',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** One business the user belongs to. */
export const UserBusinessSchema = z.object({
  tenantId: TenantIdSchema,
  name: z.string(),
  slug: TenantSlugSchema,
  role: MembershipRoleSchema,
});
export type UserBusiness = z.infer<typeof UserBusinessSchema>;

/** `GET /v1/me`: who is signed in, which business is active, and which they can switch to. */
export const MeResponseSchema = z.object({
  user: z.object({
    id: UserIdSchema,
    name: z.string(),
    email: z.email(),
    twoFactorEnabled: z.boolean(),
  }),
  activeTenantId: TenantIdSchema.nullable(),
  businesses: z.array(UserBusinessSchema),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * `PUT /v1/me/active-tenant`: choose one of the user's own businesses for this session. The id
 * is checked against the user's memberships before it is stored in the session; requests take
 * their tenant from the session, never from this body.
 */
export const SetActiveTenantRequestSchema = z.object({ tenantId: TenantIdSchema }).strict();
export type SetActiveTenantRequest = z.infer<typeof SetActiveTenantRequestSchema>;

/**
 * The business's phone as its clients call it (S47): spaces, dashes, dots and brackets are
 * dropped, ten US digits get +1, and the result is the international form (`+15551234567`).
 */
export const BusinessPhoneSchema = z
  .string()
  .transform((value) => {
    const digits = value.replace(/[\s().-]/g, '');
    if (/^\d{10}$/.test(digits)) return `+1${digits}`;
    if (/^1\d{10}$/.test(digits)) return `+${digits}`;
    return digits;
  })
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, 'Enter a phone number such as (555) 123-4567'));
export type BusinessPhone = z.infer<typeof BusinessPhoneSchema>;

/**
 * Where clients find the business, as the booking page shows it (S47, D-3): the mailing
 * address's rules, kept apart from it (a barber working from home may not show that one).
 */
export const PublicAddressSchema = MailingAddressSchema;

/** The most a cancellation policy may say (characters). */
export const CANCELLATION_POLICY_MAX = 600;

/** The cancellation policy in the business's words, shown on the booking page (S47). */
export const CancellationPolicySchema = z
  .string()
  .transform((value) =>
    value
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line !== '')
      .join('\n'),
  )
  .pipe(
    z
      .string()
      .min(1, 'Write the policy, or leave it empty')
      .max(CANCELLATION_POLICY_MAX, `At most ${String(CANCELLATION_POLICY_MAX)} characters`)
      .refine((value) => value.split('\n').length <= 8, 'At most 8 lines'),
  );

/** What clients see about the business besides its menu (S47); `null`: not shown. */
export const BusinessProfileSchema = z.object({
  phone: BusinessPhoneSchema.nullable(),
  publicAddress: PublicAddressSchema.nullable(),
  cancellationPolicy: CancellationPolicySchema.nullable(),
});
export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;

/** A business as its members see it. */
export const BusinessSchema = z
  .object({
    id: TenantIdSchema,
    name: z.string(),
    slug: TenantSlugSchema,
    timeZone: TimeZoneSchema,
    locale: LocaleSchema,
    /** The industry template it started from; `null`: none (platform defaults). */
    templateId: TemplateIdSchema.nullable(),
    /** The booking page's color (PCR-001); `null`: Pepper's neutral default. */
    brandColor: BrandColorSchema.nullable(),
  })
  .extend(BusinessProfileSchema.shape);
export type Business = z.infer<typeof BusinessSchema>;

/**
 * `PUT /v1/tenant/booking-page`: the booking page's settings (owners and managers). A field
 * left out stays as it is (S47 added the profile next to the color); at least one is needed.
 */
export const BookingPageSettingsSchema = z
  .object({ brandColor: BrandColorSchema.nullable() })
  .extend(BusinessProfileSchema.shape)
  .partial()
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, 'Nothing to change');
export type BookingPageSettings = z.infer<typeof BookingPageSettingsSchema>;

/**
 * `GET /v1/tenant`: the session's active business, the user's role in it, and what that role
 * may do (the permission matrix in core), so the UI shows only what the api will allow.
 */
export const CurrentBusinessResponseSchema = z.object({
  business: BusinessSchema,
  role: MembershipRoleSchema,
  permissions: z.array(PermissionSchema),
});
export type CurrentBusinessResponse = z.infer<typeof CurrentBusinessResponseSchema>;

/** A member of the active business, as the team page lists them. */
export const MemberSchema = z.object({
  userId: UserIdSchema,
  name: z.string(),
  email: z.email(),
  role: MembershipRoleSchema,
  joinedAt: UtcDateTimeSchema,
});
export type Member = z.infer<typeof MemberSchema>;

/** `GET /v1/members`: everyone in the active business, longest-standing first. */
export const MembersResponseSchema = z.object({ members: z.array(MemberSchema) });
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

/** `PATCH /v1/members/:userId`: give a member another role. */
export const ChangeMemberRoleRequestSchema = z.object({ role: MembershipRoleSchema }).strict();
export type ChangeMemberRoleRequest = z.infer<typeof ChangeMemberRoleRequestSchema>;
