import { z } from 'zod';
import {
  LocaleSchema,
  MembershipRoleSchema,
  TenantIdSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';

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
});
export type Business = z.infer<typeof BusinessSchema>;

/** `GET /v1/tenant`: the session's active business and the user's role in it. */
export const CurrentBusinessResponseSchema = z.object({
  business: BusinessSchema,
  role: MembershipRoleSchema,
});
export type CurrentBusinessResponse = z.infer<typeof CurrentBusinessResponseSchema>;
