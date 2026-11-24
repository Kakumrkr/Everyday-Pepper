import { describe, expect, it } from 'vitest';
import {
  ApiErrorSchema,
  BookingPageSettingsSchema,
  BusinessPhoneSchema,
  CancellationPolicySchema,
  PublicAddressSchema,
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
        templateId: 'beauty-salon',
        brandColor: '#7a3e6c',
        depositRefundHours: 24,
        depositAudience: 'everyone',
        phone: null,
        publicAddress: null,
        cancellationPolicy: null,
      },
      role: 'staff',
      permissions: ['business.read', 'calendar.read'],
    };
    expect(CurrentBusinessResponseSchema.parse(body)).toEqual(body);
  });

  it('rejects an unknown permission or a missing list', () => {
    const body = {
      business: {
        id: TENANT,
        name: 'Juniper Hair Studio',
        slug: 'juniper',
        timeZone: 'America/New_York',
        locale: 'en-US',
        templateId: null,
        brandColor: null,
      },
      role: 'staff',
    };
    expect(CurrentBusinessResponseSchema.safeParse(body).success).toBe(false);
    expect(
      CurrentBusinessResponseSchema.safeParse({ ...body, permissions: ['everything'] }).success,
    ).toBe(false);
  });
});

describe('the business profile (S47, AC-W8-7)', () => {
  it('turns the ways owners write a US phone into the international form', () => {
    for (const typed of ['(555) 123-4567', '555.123.4567', '555-123-4567', '1 555 123 4567']) {
      expect(BusinessPhoneSchema.parse(typed)).toBe('+15551234567');
    }
    expect(BusinessPhoneSchema.parse('+44 20 7946 0958')).toBe('+442079460958');
  });

  it('refuses what is not a phone number', () => {
    for (const typed of ['123', 'call me', '+0123456789', '555 123 456 789 0123', '']) {
      expect(BusinessPhoneSchema.safeParse(typed).success).toBe(false);
    }
  });

  it('keeps an address to a few tidy lines without contact details', () => {
    expect(PublicAddressSchema.parse('  12  Main St \n\n Austin, TX 78701 ')).toBe(
      '12 Main St\nAustin, TX 78701',
    );
    expect(PublicAddressSchema.safeParse('x').success).toBe(false);
    expect(PublicAddressSchema.safeParse('12 Main St, call +15551234567').success).toBe(false);
  });

  it('keeps a policy to 600 characters and 8 lines', () => {
    expect(CancellationPolicySchema.parse(' Cancel  24 hours ahead. \n\n Thanks ')).toBe(
      'Cancel 24 hours ahead.\nThanks',
    );
    expect(CancellationPolicySchema.safeParse('   ').success).toBe(false);
    expect(CancellationPolicySchema.safeParse('a'.repeat(601)).success).toBe(false);
    expect(CancellationPolicySchema.safeParse(Array(9).fill('line').join('\n')).success).toBe(
      false,
    );
  });
});

describe('BookingPageSettingsSchema', () => {
  it('changes only the fields sent (S47)', () => {
    expect(BookingPageSettingsSchema.parse({ phone: '(555) 123-4567' })).toEqual({
      phone: '+15551234567',
    });
    expect(
      BookingPageSettingsSchema.parse({ publicAddress: null, cancellationPolicy: null }),
    ).toEqual({ publicAddress: null, cancellationPolicy: null });
  });

  it('takes a color or null (the neutral default)', () => {
    expect(BookingPageSettingsSchema.parse({ brandColor: '#7A3E6C' })).toEqual({
      brandColor: '#7a3e6c',
    });
    expect(BookingPageSettingsSchema.parse({ brandColor: null })).toEqual({ brandColor: null });
  });

  it('rejects a missing or invalid color and unknown fields', () => {
    expect(BookingPageSettingsSchema.safeParse({}).success).toBe(false);
    expect(BookingPageSettingsSchema.safeParse({ brandColor: 'plum' }).success).toBe(false);
    expect(BookingPageSettingsSchema.safeParse({ brandColor: null, slug: 'other' }).success).toBe(
      false,
    );
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
