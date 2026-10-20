import { z } from 'zod';
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
  // The public booking page (ADR-0022).
  'booking_page_not_found',
  'booking_request_not_found',
  'booking_request_expired',
  'booking_request_used',
  'wrong_code',
  'too_many_requests',
  'email_unavailable',
  'temporarily_unavailable',
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

/** A business as its members see it. */
export const BusinessSchema = z.object({
  id: TenantIdSchema,
  name: z.string(),
  slug: TenantSlugSchema,
  timeZone: TimeZoneSchema,
  locale: LocaleSchema,
  /** The industry template it started from; `null`: none (platform defaults). */
  templateId: TemplateIdSchema.nullable(),
  /** The booking page's color (PCR-001); `null`: Pepper's neutral default. */
  brandColor: BrandColorSchema.nullable(),
});
export type Business = z.infer<typeof BusinessSchema>;

/** `PUT /v1/tenant/booking-page`: the booking page's settings (owners and managers). */
export const BookingPageSettingsSchema = z
  .object({ brandColor: BrandColorSchema.nullable() })
  .strict();
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
