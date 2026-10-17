import { describe, expect, it } from 'vitest';
import {
  LocaleSchema,
  MembershipRoleSchema,
  NewTenantSchema,
  TenantIdSchema,
  TenantSlugSchema,
  TimeZoneSchema,
  UserIdSchema,
} from './tenancy.js';

describe('TenantIdSchema / UserIdSchema', () => {
  it('accept UUIDs', () => {
    const id = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
    expect(TenantIdSchema.parse(id)).toBe(id);
    expect(UserIdSchema.parse(id)).toBe(id);
  });

  it('lowercase them, so the same id always compares equal', () => {
    const id = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F708192';
    expect(TenantIdSchema.parse(id)).toBe(id.toLowerCase());
    expect(UserIdSchema.parse(id)).toBe(id.toLowerCase());
  });

  it.each(['', 'tenant-1', "' OR 1=1 --", '0199f0a4-7c1e-7d2a-9b3c'])('reject %j', (value) => {
    expect(TenantIdSchema.safeParse(value).success).toBe(false);
    expect(UserIdSchema.safeParse(value).success).toBe(false);
  });
});

describe('TenantSlugSchema', () => {
  it.each(['juniper', 'juniper-hair', 'a1b', 'x'.repeat(63)])('accepts %s', (value) => {
    expect(TenantSlugSchema.parse(value)).toBe(value);
  });

  it.each([
    'ab', // too short
    'x'.repeat(64), // too long
    'Juniper', // uppercase
    '1juniper', // must start with a letter
    'juniper-', // trailing hyphen
    'juni--per', // double hyphen
    'juni per',
    'juniper_hair',
  ])('rejects %j', (value) => {
    expect(TenantSlugSchema.safeParse(value).success).toBe(false);
  });
});

describe('TimeZoneSchema', () => {
  it.each(['America/New_York', 'America/Los_Angeles', 'UTC', 'America/Argentina/Buenos_Aires'])(
    'accepts %s',
    (value) => {
      expect(TimeZoneSchema.parse(value)).toBe(value);
    },
  );

  it.each(['Mars/Olympus_Mons', 'EST5EDT; DROP', '', '../etc/passwd', 'America/'])(
    'rejects %j',
    (value) => {
      expect(TimeZoneSchema.safeParse(value).success).toBe(false);
    },
  );
});

describe('LocaleSchema', () => {
  it.each(['en-US', 'es-US', 'en'])('accepts %s', (value) => {
    expect(LocaleSchema.parse(value)).toBe(value);
  });

  it.each(['en_us', 'EN-us', 'not a locale', ''])('rejects %j', (value) => {
    expect(LocaleSchema.safeParse(value).success).toBe(false);
  });
});

describe('MembershipRoleSchema', () => {
  it('has the three V1 roles', () => {
    expect(MembershipRoleSchema.options).toEqual(['owner', 'manager', 'staff']);
  });
});

describe('NewTenantSchema', () => {
  it('trims the name and defaults the locale', () => {
    expect(
      NewTenantSchema.parse({
        name: '  Juniper Hair Studio ',
        slug: 'juniper',
        timeZone: 'America/New_York',
      }),
    ).toEqual({
      name: 'Juniper Hair Studio',
      slug: 'juniper',
      timeZone: 'America/New_York',
      locale: 'en-US',
    });
  });

  it('rejects a blank name', () => {
    expect(
      NewTenantSchema.safeParse({ name: '   ', slug: 'juniper', timeZone: 'UTC' }).success,
    ).toBe(false);
  });
});
