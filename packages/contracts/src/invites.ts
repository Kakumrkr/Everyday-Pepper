import { z } from 'zod';
import { MembershipRoleSchema, TenantIdSchema, UserIdSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// Inviting someone to a business (ADR-0014): an owner or manager creates an invite for one
// email and role and shares its link; the invitee signs in (or signs up) with that email and
// accepts it. Email delivery comes in Phase 5; until then the link is copied by hand.

/**
 * The secret in an invite link: 32 random bytes, base64url (43 characters). It travels in the
 * link's fragment and in request bodies, never in a URL the servers log; only its SHA-256 hash
 * is stored.
 */
export const InviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid invite token');
export type InviteToken = z.infer<typeof InviteTokenSchema>;

/** An email address as invites store and compare it: trimmed and lowercased. */
export const InviteEmailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** `POST /v1/invites`: invite one person to the active business with a role. */
export const CreateInviteRequestSchema = z
  .object({ email: InviteEmailSchema, role: MembershipRoleSchema })
  .strict();
export type CreateInviteRequest = z.input<typeof CreateInviteRequestSchema>;

/** An open invite, as the team page lists it (never with its token). */
export const InviteSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: MembershipRoleSchema,
  /** Who created it; `null` once their account is deleted. */
  invitedBy: UserIdSchema.nullable(),
  createdAt: UtcDateTimeSchema,
  expiresAt: UtcDateTimeSchema,
});
export type Invite = z.infer<typeof InviteSchema>;

/** `GET /v1/invites`: the active business's open invites, newest first. */
export const InvitesResponseSchema = z.object({ invites: z.array(InviteSchema) });
export type InvitesResponse = z.infer<typeof InvitesResponseSchema>;

/**
 * `POST /v1/invites` (201): the invite and its token. The token is returned this once; it
 * cannot be read again, so a lost link is replaced by inviting the same email again.
 */
export const CreateInviteResponseSchema = z.object({
  invite: InviteSchema,
  token: InviteTokenSchema,
});
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

/** Body of `POST /v1/invites/lookup` and `POST /v1/invites/accept`. */
export const InviteTokenRequestSchema = z.object({ token: InviteTokenSchema }).strict();
export type InviteTokenRequest = z.infer<typeof InviteTokenRequestSchema>;

/**
 * `POST /v1/invites/lookup`: what the signed-in invitee is about to join. Answered only for
 * the account the invite is for, so a forwarded link reveals nothing.
 */
export const InvitePreviewResponseSchema = z.object({
  businessName: z.string(),
  role: MembershipRoleSchema,
  expiresAt: UtcDateTimeSchema,
});
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponseSchema>;

/** `POST /v1/invites/accept`: the business joined, now the session's active business. */
export const AcceptInviteResponseSchema = z.object({
  tenantId: TenantIdSchema,
  role: MembershipRoleSchema,
});
export type AcceptInviteResponse = z.infer<typeof AcceptInviteResponseSchema>;
