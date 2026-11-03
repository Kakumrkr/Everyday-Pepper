import { describe, expect, it } from 'vitest';
import {
  BookingConfirmInputSchema,
  BookingRequestInputSchema,
  ManageBookingInputSchema,
  ManageTokenSchema,
  PublicBusinessSchema,
  PublicRescheduleInputSchema,
  VerificationCodeSchema,
} from './public-booking.js';

const TOKEN = 'q1W2e3R4t5Y6u7I8o9P0a_S-d1F2g3H4j5K6l7Z8x9C';
const SERVICE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708196';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';
const REQUEST = {
  serviceId: SERVICE,
  startsAt: '2026-11-02T15:30:00.000Z',
  name: '  Ana Ruiz ',
  email: ' Ana@Example.TEST ',
};

describe('BookingRequestInputSchema', () => {
  it('trims and lowercases, and defaults to anyone and no phone', () => {
    expect(BookingRequestInputSchema.parse(REQUEST)).toEqual({
      serviceId: SERVICE,
      staffMemberId: null,
      startsAt: '2026-11-02T15:30:00.000Z',
      name: 'Ana Ruiz',
      email: 'ana@example.test',
      phone: null,
    });
  });

  it('keeps a staff member and an E.164 phone', () => {
    const parsed = BookingRequestInputSchema.parse({
      ...REQUEST,
      staffMemberId: STAFF,
      phone: '+15551234567',
    });
    expect(parsed).toMatchObject({ staffMemberId: STAFF, phone: '+15551234567' });
  });

  it.each([
    ['a blank name', { name: '  ' }],
    ['a long name', { name: 'a'.repeat(121) }],
    ['no email', { email: '' }],
    ['a bad email', { email: 'ana@' }],
    ['a local phone', { phone: '555 123 4567' }],
    ['a time with an offset', { startsAt: '2026-11-02T10:30:00-05:00' }],
    ['an unknown field', { tenantId: SERVICE }],
  ])('rejects %s', (_label, change) => {
    expect(BookingRequestInputSchema.safeParse({ ...REQUEST, ...change }).success).toBe(false);
  });
});

describe('VerificationCodeSchema', () => {
  it('accepts six digits, trimmed', () => {
    expect(VerificationCodeSchema.parse(' 012345 ')).toBe('012345');
    expect(BookingConfirmInputSchema.parse({ code: '999999' })).toEqual({ code: '999999' });
    expect(
      BookingConfirmInputSchema.parse({ code: '999999', startsAt: '2026-11-02T16:00:00.000Z' }),
    ).toEqual({ code: '999999', startsAt: '2026-11-02T16:00:00.000Z' });
  });

  it.each(['12345', '1234567', '12a456', '', '١٢٣٤٥٦'])('rejects %j', (code) => {
    expect(VerificationCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('ManageTokenSchema', () => {
  it('accepts 43 base64url characters (32 bytes)', () => {
    expect(ManageTokenSchema.parse(TOKEN)).toBe(TOKEN);
    expect(ManageBookingInputSchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
  });

  it.each([TOKEN.slice(1), `${TOKEN}A`, `${TOKEN.slice(0, 42)}+`, ''])('rejects %j', (token) => {
    expect(ManageTokenSchema.safeParse(token).success).toBe(false);
  });

  it('reschedules to a UTC time only', () => {
    expect(
      PublicRescheduleInputSchema.safeParse({ token: TOKEN, startsAt: '2026-11-02T16:00:00Z' })
        .success,
    ).toBe(true);
    expect(
      PublicRescheduleInputSchema.safeParse({ token: TOKEN, startsAt: 'tomorrow' }).success,
    ).toBe(false);
  });
});

describe('PublicBusinessSchema', () => {
  it('describes the page without any tenant id', () => {
    expect(Object.keys(PublicBusinessSchema.shape)).not.toContain('id');
    const parsed = PublicBusinessSchema.parse({
      name: 'Plum Salon',
      slug: 'plum-salon',
      timeZone: 'America/Chicago',
      brandColor: '#7a3e6c',
      services: [],
      staff: [],
      phone: '+15551234567',
      publicAddress: '12 Main St\nAustin, TX 78701',
      cancellationPolicy: null,
      photos: { logo: null, cover: null, gallery: [] },
    });
    expect(parsed.brandColor).toBe('#7a3e6c');
    expect(parsed.phone).toBe('+15551234567');
  });
});
