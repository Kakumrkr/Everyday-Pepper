import { describe, expect, it } from 'vitest';
import {
  AvailabilityQuerySchema,
  BookingChangeSchema,
  BookingInputSchema,
  BookingSourceSchema,
  BookingsQuerySchema,
  BookingStatusSchema,
  BusyQuerySchema,
  canChangeStatus,
  IdempotencyKeySchema,
  statusNeedsStart,
} from './bookings.js';

const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const SERVICE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';
const STAFF = '0199F0A4-7C1E-7D2A-9B3C-4D5E6F708198';

const booking = {
  clientId: CLIENT,
  serviceId: SERVICE,
  staffMemberId: STAFF,
  startsAt: '2026-10-20T14:00:00.000Z',
};

describe('BookingInputSchema', () => {
  it('defaults override to false and lowercases ids', () => {
    expect(BookingInputSchema.parse(booking)).toEqual({
      ...booking,
      staffMemberId: STAFF.toLowerCase(),
      override: false,
    });
  });

  it('keeps an idempotency key', () => {
    const key = 'ai-run-0199f0a4';
    expect(BookingInputSchema.parse({ ...booking, idempotencyKey: key }).idempotencyKey).toBe(key);
  });

  it.each([
    ['a start with an offset', { ...booking, startsAt: '2026-10-20T10:00:00-04:00' }],
    ['a missing client', { ...booking, clientId: undefined }],
    ['a status', { ...booking, status: 'completed' }],
    ['a source (taken from who books)', { ...booking, source: 'booking_page' }],
    ['a short idempotency key', { ...booking, idempotencyKey: 'short' }],
  ])('rejects %s', (_label, input) => {
    expect(BookingInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('BookingChangeSchema', () => {
  it('reads a move, with or without another staff member', () => {
    expect(BookingChangeSchema.parse({ startsAt: booking.startsAt })).toEqual({
      startsAt: booking.startsAt,
      override: false,
    });
    expect(
      BookingChangeSchema.parse({ startsAt: booking.startsAt, staffMemberId: STAFF }),
    ).toMatchObject({ staffMemberId: STAFF.toLowerCase() });
  });

  it.each(['completed', 'no_show', 'cancelled'])('reads a status change to %s', (status) => {
    expect(BookingChangeSchema.parse({ status })).toEqual({ status });
  });

  it.each([
    ['back to confirmed', { status: 'confirmed' }],
    ['a move and a status at once', { startsAt: booking.startsAt, status: 'cancelled' }],
    ['a new client', { startsAt: booking.startsAt, clientId: CLIENT }],
    ['nothing', {}],
  ])('rejects %s', (_label, input) => {
    expect(BookingChangeSchema.safeParse(input).success).toBe(false);
  });
});

describe('status rules', () => {
  const statuses = BookingStatusSchema.options;

  it('owners and managers: a cancelled booking is final; anything else may change', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canChangeStatus(from, to, true), `${from} → ${to}`).toBe(
          from !== 'cancelled' && from !== to,
        );
      }
    }
  });

  it('staff: completed and no-show are final too; a confirmed booking may still change', () => {
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canChangeStatus(from, to, false), `${from} → ${to}`).toBe(
          from === 'confirmed' && to !== 'confirmed',
        );
      }
    }
  });

  it('only completed and no-show need the appointment to have started', () => {
    expect(statuses.filter(statusNeedsStart)).toEqual(['completed', 'no_show']);
  });

  it('a booking does not come from an import', () => {
    expect(BookingSourceSchema.options).toEqual(['team', 'ai', 'booking_page']);
  });
});

describe('IdempotencyKeySchema', () => {
  it.each(['abcdefgh', 'A-b_0123456789', 'x'.repeat(100)])('accepts %s', (key) => {
    expect(IdempotencyKeySchema.parse(key)).toBe(key);
  });

  it.each(['abcdefg', 'x'.repeat(101), 'has space', 'semi;colon'])('rejects %s', (key) => {
    expect(IdempotencyKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('range queries', () => {
  const from = '2026-10-01T00:00:00.000Z';

  it.each([
    ['bookings', BookingsQuerySchema, {}],
    ['busy times', BusyQuerySchema, {}],
    ['availability', AvailabilityQuerySchema, { serviceId: SERVICE }],
  ])('%s: accept up to 62 days, not more, and not backwards', (_label, schema, extra) => {
    const ok = schema.safeParse({ ...extra, from, to: '2026-12-02T00:00:00.000Z' });
    expect(ok.success).toBe(true);
    const tooLong = schema.safeParse({ ...extra, from, to: '2026-12-02T00:00:00.001Z' });
    expect(tooLong.error?.issues[0]?.message).toBe('Ask about at most 62 days at once');
    const empty = schema.safeParse({ ...extra, from, to: from });
    expect(empty.error?.issues[0]?.message).toBe('The end must be after the start');
  });

  it('bookings filter by staff member and status', () => {
    expect(
      BookingsQuerySchema.parse({
        from,
        to: '2026-10-02T00:00:00.000Z',
        staffMemberId: STAFF,
        status: 'cancelled',
      }),
    ).toMatchObject({ staffMemberId: STAFF.toLowerCase(), status: 'cancelled' });
  });

  it('bookings filter by client (a client’s visits)', () => {
    const range = { from, to: '2026-10-02T00:00:00.000Z' };
    expect(BookingsQuerySchema.parse({ ...range, clientId: CLIENT.toUpperCase() })).toMatchObject({
      clientId: CLIENT,
    });
    expect(BookingsQuerySchema.safeParse({ ...range, clientId: 'maria' }).success).toBe(false);
  });

  it('availability needs a service', () => {
    expect(
      AvailabilityQuerySchema.safeParse({ from, to: '2026-10-02T00:00:00.000Z' }).success,
    ).toBe(false);
  });
});
