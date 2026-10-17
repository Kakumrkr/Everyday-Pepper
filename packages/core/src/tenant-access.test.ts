import { TenantIdSchema, UserIdSchema, type MembershipRole } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import { decideTenantAccess, type TenantAccessInput } from './tenant-access.js';

const tenantId = TenantIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192');
const userId = UserIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193');
const base: TenantAccessInput = {
  userId,
  activeTenantId: tenantId,
  role: 'staff',
  twoFactorEnabled: false,
};

describe('decideTenantAccess', () => {
  it('denies without an active business', () => {
    expect(decideTenantAccess({ ...base, activeTenantId: null, role: null })).toEqual({
      allowed: false,
      reason: 'no_active_tenant',
    });
  });

  it('denies a user who is not (or no longer) a member', () => {
    expect(decideTenantAccess({ ...base, role: null, twoFactorEnabled: true })).toEqual({
      allowed: false,
      reason: 'not_a_member',
    });
  });

  it.each<MembershipRole>(['owner', 'manager'])('denies a %s without MFA', (role) => {
    expect(decideTenantAccess({ ...base, role })).toEqual({
      allowed: false,
      reason: 'mfa_required',
    });
  });

  it.each<[MembershipRole, boolean]>([
    ['owner', true],
    ['manager', true],
    ['staff', false],
    ['staff', true],
  ])('allows a %s (MFA %s) with the context of the active business', (role, twoFactorEnabled) => {
    expect(decideTenantAccess({ ...base, role, twoFactorEnabled })).toEqual({
      allowed: true,
      context: { tenantId, userId, role },
    });
  });
});
