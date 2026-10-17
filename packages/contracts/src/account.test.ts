import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  ChangeMemberRoleRequestSchema,
  CurrentBusinessResponseSchema,
  MeResponseSchema,
  MembersResponseSchema,
  SetActiveTenantRequestSchema,
} from './account.js';

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';

describe('MeResponseSchema', () => {
  const me = {
    user: { id: USER, name: 'Ana Reyes', email: 'ana@example.test', twoFactorEnabled: true },
    activeTenantId: TENANT,
    businesses: [{ tenantId: TENANT, name: 'Juniper Hair Studio', slug: 'juniper', role: 'owner' }],
  };

  it('accepts a signed-in user with businesses', () => {
    expect(MeResponseSchema.parse(me)).toEqual(me);
  });

  it('accepts a user without an active business', () => {
    expect(MeResponseSchema.parse({ ...me, activeTenantId: null, businesses: [] })).toBeTruthy();
  });

  it('rejects an unknown role', () => {
    const bad = { ...me, businesses: [{ ...me.businesses[0], role: 'admin' }] };
    expect(MeResponseSchema.safeParse(bad).success).toBe(false);
  });
});

describe('SetActiveTenantRequestSchema', () => {
  it('accepts a tenant id', () => {
    expect(SetActiveTenantRequestSchema.parse({ tenantId: TENANT })).toEqual({ tenantId: TENANT });
  });

  it.each([{}, { tenantId: 'nope' }, { tenantId: TENANT, userId: USER }])('rejects %j', (body) => {
    expect(SetActiveTenantRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('CurrentBusinessResponseSchema', () => {
  it('accepts a business and role', () => {
    const body = {
      business: {
        id: TENANT,
        name: 'Juniper Hair Studio',
        slug: 'juniper',
        timeZone: 'America/New_York',
        locale: 'en-US',
      },
      role: 'staff',
    };
    expect(CurrentBusinessResponseSchema.parse(body)).toEqual(body);
  });
});

describe('ApiErrorSchema', () => {
  it('accepts known codes only', () => {
    expect(ApiErrorSchema.safeParse({ code: 'mfa_required', message: 'Set up MFA' }).success).toBe(
      true,
    );
    expect(ApiErrorSchema.safeParse({ code: 'teapot', message: 'no' }).success).toBe(false);
  });
});

describe('members', () => {
  const member = {
    userId: USER,
    name: 'Ana Reyes',
    email: 'ana@example.test',
    role: 'owner',
    joinedAt: '2026-10-17T12:00:00.000Z',
  };

  it('accepts a member list', () => {
    expect(MembersResponseSchema.parse({ members: [member] })).toEqual({ members: [member] });
  });

  it('rejects a local time', () => {
    const local = { ...member, joinedAt: '2026-10-17T08:00:00-04:00' };
    expect(MembersResponseSchema.safeParse({ members: [local] }).success).toBe(false);
  });

  it.each([{ role: 'manager' }])('accepts the role change %j', (body) => {
    expect(ChangeMemberRoleRequestSchema.parse(body)).toEqual(body);
  });

  it.each([
    {},
    { role: 'admin' },
    { role: 'staff', userId: USER },
    { role: 'staff', tenantId: TENANT },
  ])('rejects the role change %j', (body) => {
    expect(ChangeMemberRoleRequestSchema.safeParse(body).success).toBe(false);
  });
});
