import {
  roleRequiresMfa,
  type MembershipRole,
  type TenantId,
  type UserId,
} from '@pepper/contracts';

/** Who is acting, in which business, with which role: what tenant-scoped work runs as. */
export interface TenantContext {
  tenantId: TenantId;
  userId: UserId;
  role: MembershipRole;
}

/** Why a signed-in user may not work in a business right now. */
export type TenantAccessDenial = 'no_active_tenant' | 'not_a_member' | 'mfa_required';

export type TenantAccess =
  { allowed: true; context: TenantContext } | { allowed: false; reason: TenantAccessDenial };

export interface TenantAccessInput {
  userId: UserId;
  /** The business chosen for the session; `null` when none is chosen yet. */
  activeTenantId: TenantId | null;
  /** The user's role in `activeTenantId` now (not when the session started); `null` if none. */
  role: MembershipRole | null;
  /** Whether the user has a verified second factor (TOTP). */
  twoFactorEnabled: boolean;
}

/**
 * Decides whether a signed-in user may work in the session's active business. Membership is
 * re-checked on every request, so removing a member takes effect at once; owners and managers
 * must have MFA (`roleRequiresMfa`), so a stolen password alone never reaches all of a
 * business's clients.
 */
export function decideTenantAccess(input: TenantAccessInput): TenantAccess {
  if (input.activeTenantId === null) return { allowed: false, reason: 'no_active_tenant' };
  if (input.role === null) return { allowed: false, reason: 'not_a_member' };
  if (roleRequiresMfa(input.role) && !input.twoFactorEnabled) {
    return { allowed: false, reason: 'mfa_required' };
  }
  return {
    allowed: true,
    context: { tenantId: input.activeTenantId, userId: input.userId, role: input.role },
  };
}
