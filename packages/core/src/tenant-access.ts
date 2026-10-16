import type { MembershipRole, TenantId, UserId } from '@floty/contracts';

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

/** Roles that must have a second factor before they can work in a business (ADR-0007). */
const ROLES_REQUIRING_MFA: ReadonlySet<MembershipRole> = new Set(['owner']);

/**
 * Decides whether a signed-in user may work in the session's active business. Membership is
 * re-checked on every request, so removing a member takes effect at once; owners must have
 * MFA, so a stolen password alone never reaches an owner's business.
 */
export function decideTenantAccess(input: TenantAccessInput): TenantAccess {
  if (input.activeTenantId === null) return { allowed: false, reason: 'no_active_tenant' };
  if (input.role === null) return { allowed: false, reason: 'not_a_member' };
  if (ROLES_REQUIRING_MFA.has(input.role) && !input.twoFactorEnabled) {
    return { allowed: false, reason: 'mfa_required' };
  }
  return {
    allowed: true,
    context: { tenantId: input.activeTenantId, userId: input.userId, role: input.role },
  };
}
