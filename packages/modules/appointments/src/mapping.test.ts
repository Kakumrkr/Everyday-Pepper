import type {
  BookingRow,
  BookingRuleRow,
  ServiceRow,
  StaffMemberRecord,
  TimeOffRow,
  WaitlistEntryRow,
} from '@pepper/db';
import { describe, expect, it } from 'vitest';
import {
  bookingAuditValues,
  hoursToMinutes,
  toBooking,
  toBusyTime,
  toWaitlistEntry,
  waitlistAuditValues,
  rowsToRules,
  minutesToHours,
  sameValues,
  serviceAuditValues,
  staffAuditValues,
  staffOwner,
  timeOffAuditValues,
  toService,
  toStaffMember,
  toTimeOff,
} from './mapping.js';

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';
const SERVICE = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198';
const TIME_OFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708199';
const CREATED = new Date('2026-10-17T12:00:00.000Z');
const UPDATED = new Date('2026-10-17T12:05:00.000Z');

const serviceRow: ServiceRow = {
  id: SERVICE,
  tenantId: TENANT,
  name: "Women's haircut",
  category: 'Cuts',
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceFromCents: 4000,
  priceToCents: 6000,
  active: true,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

const staffRecord: StaffMemberRecord = {
  id: STAFF,
  tenantId: TENANT,
  displayName: 'Jess',
  color: '#2a7230',
  active: true,
  membershipId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708195',
  userId: USER,
  serviceIds: [SERVICE],
  createdAt: CREATED,
  updatedAt: UPDATED,
};

const timeOffRow: TimeOffRow = {
  id: TIME_OFF,
  tenantId: TENANT,
  staffMemberId: STAFF,
  startsAt: new Date('2026-10-20T13:00:00.000Z'),
  endsAt: new Date('2026-10-20T17:00:00.000Z'),
  createdByUserId: USER,
  createdAt: CREATED,
};

describe('services', () => {
  it('maps a row to the api shape, without the tenant', () => {
    expect(toService(serviceRow)).toEqual({
      id: SERVICE,
      name: "Women's haircut",
      category: 'Cuts',
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      priceFromCents: 4000,
      priceToCents: 6000,
      active: true,
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:05:00.000Z',
    });
  });

  it('audits the service fields only', () => {
    expect(Object.keys(serviceAuditValues(serviceRow)).sort()).toEqual(
      [
        'active',
        'bufferAfterMinutes',
        'bufferBeforeMinutes',
        'category',
        'durationMinutes',
        'name',
        'priceFromCents',
        'priceToCents',
      ].sort(),
    );
  });
});

describe('staff members', () => {
  it('maps a record to the api shape', () => {
    expect(toStaffMember(staffRecord)).toEqual({
      id: STAFF,
      displayName: 'Jess',
      color: '#2a7230',
      active: true,
      userId: USER,
      serviceIds: [SERVICE],
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:05:00.000Z',
    });
  });

  it('keeps the display name and colour out of the audit log', () => {
    expect(staffAuditValues(staffRecord)).toEqual({
      active: true,
      userId: USER,
      serviceIds: [SERVICE],
    });
    expect(staffAuditValues({ ...staffRecord, userId: null })).toMatchObject({ userId: null });
  });

  it('is owned by the linked user, or nobody', () => {
    expect(staffOwner(staffRecord)).toEqual({ ownerUserId: USER });
    expect(staffOwner({ ...staffRecord, userId: null })).toEqual({ ownerUserId: null });
  });
});

describe('working hours', () => {
  it('converts between HH:MM and minutes after midnight, both ways', () => {
    const hours = {
      intervals: [
        { weekday: 1, start: '09:00', end: '12:30' },
        { weekday: 1, start: '13:30', end: '24:00' },
      ],
    };
    const minutes = [
      { weekday: 1, startMinute: 540, endMinute: 750 },
      { weekday: 1, startMinute: 810, endMinute: 1440 },
    ];
    expect(hoursToMinutes(hours)).toEqual(minutes);
    expect(minutesToHours(minutes)).toEqual(hours);
    expect(minutesToHours([])).toEqual({ intervals: [] });
  });
});

describe('time off', () => {
  it('maps a row and audits whose and when only', () => {
    expect(toTimeOff(timeOffRow)).toEqual({
      id: TIME_OFF,
      staffMemberId: STAFF,
      startsAt: '2026-10-20T13:00:00.000Z',
      endsAt: '2026-10-20T17:00:00.000Z',
      createdAt: '2026-10-17T12:00:00.000Z',
    });
    expect(timeOffAuditValues(timeOffRow)).toEqual({
      staffMemberId: STAFF,
      startsAt: '2026-10-20T13:00:00.000Z',
      endsAt: '2026-10-20T17:00:00.000Z',
    });
  });
});

describe('sameValues', () => {
  it('compares audit values structurally', () => {
    expect(sameValues({ a: 1, b: [1] }, { a: 1, b: [1] })).toBe(true);
    expect(sameValues({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('rowsToRules', () => {
  const row = (fields: Partial<BookingRuleRow>): BookingRuleRow => ({
    id: TIME_OFF,
    tenantId: TENANT,
    staffMemberId: null,
    type: 'minimum_notice',
    version: 1,
    params: { minutes: 60 },
    createdAt: CREATED,
    ...fields,
  });

  it('validates and sorts stored rules', () => {
    expect(
      rowsToRules([
        row({ staffMemberId: STAFF, params: { minutes: 0 } }),
        row({ type: 'slot_interval', params: { minutes: 30 } }),
      ]),
    ).toEqual({
      rules: [
        { type: 'slot_interval', version: 1, staffMemberId: null, params: { minutes: 30 } },
        { type: 'minimum_notice', version: 1, staffMemberId: STAFF, params: { minutes: 0 } },
      ],
    });
  });

  it('fails loudly on a rule it does not understand', () => {
    expect(() => rowsToRules([row({ version: 2 })])).toThrow();
    expect(() => rowsToRules([row({ params: { minutes: 'soon' } })])).toThrow();
  });
});

const CLIENT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190';
const BOOKING = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819b';
const WAITLIST_ENTRY = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819c';

const bookingRow: BookingRow = {
  id: BOOKING,
  tenantId: TENANT,
  clientId: CLIENT,
  serviceId: SERVICE,
  staffMemberId: STAFF,
  startsAt: new Date('2026-11-02T14:00:00.000Z'),
  endsAt: new Date('2026-11-02T15:00:00.000Z'),
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceFromCents: 6500,
  priceToCents: null,
  status: 'confirmed',
  source: 'team',
  overridden: false,
  idempotencyKey: 'ai-run-0001',
  manageTokenHash: null,
  createdByUserId: USER,
  createdAt: CREATED,
  updatedAt: UPDATED,
};

describe('bookings', () => {
  it('maps a row to the api shape, without the tenant, key or creator', () => {
    expect(toBooking(bookingRow)).toEqual({
      id: BOOKING,
      clientId: CLIENT,
      serviceId: SERVICE,
      staffMemberId: STAFF,
      startsAt: '2026-11-02T14:00:00.000Z',
      endsAt: '2026-11-02T15:00:00.000Z',
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      priceFromCents: 6500,
      priceToCents: null,
      status: 'confirmed',
      source: 'team',
      overridden: false,
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:05:00.000Z',
    });
  });

  it('audits ids, times and statuses only', () => {
    expect(bookingAuditValues(bookingRow)).toEqual({
      clientId: CLIENT,
      serviceId: SERVICE,
      staffMemberId: STAFF,
      startsAt: '2026-11-02T14:00:00.000Z',
      endsAt: '2026-11-02T15:00:00.000Z',
      status: 'confirmed',
      source: 'team',
      overridden: false,
    });
  });

  it('fails loudly on a status this code does not know', () => {
    expect(() => toBooking({ ...bookingRow, status: 'pending' })).toThrow();
  });

  it('maps occupied time to a busy time without booking details', () => {
    expect(
      toBusyTime({
        bookingId: BOOKING,
        staffMemberId: STAFF,
        startsAt: bookingRow.startsAt,
        endsAt: bookingRow.endsAt,
        occupiedFrom: bookingRow.startsAt,
        occupiedTo: new Date('2026-11-02T15:10:00.000Z'),
      }),
    ).toEqual({
      staffMemberId: STAFF,
      startsAt: '2026-11-02T14:00:00.000Z',
      endsAt: '2026-11-02T15:00:00.000Z',
      occupiedFrom: '2026-11-02T14:00:00.000Z',
      occupiedTo: '2026-11-02T15:10:00.000Z',
    });
  });
});

describe('waitlist entries', () => {
  const windows = [{ date: '2026-11-06', start: '15:00', end: '18:00' }];
  const entryRow: WaitlistEntryRow = {
    id: WAITLIST_ENTRY,
    tenantId: TENANT,
    clientId: CLIENT,
    serviceId: SERVICE,
    staffMemberId: null,
    windows,
    status: 'waiting',
    expiresAt: new Date('2026-11-06T23:00:00.000Z'),
    bookingId: null,
    createdByUserId: USER,
    createdAt: CREATED,
    updatedAt: UPDATED,
  };

  it('maps a row to the api shape', () => {
    expect(toWaitlistEntry(entryRow, new Date('2026-11-01T00:00:00Z'))).toEqual({
      id: WAITLIST_ENTRY,
      clientId: CLIENT,
      serviceId: SERVICE,
      staffMemberId: null,
      windows,
      status: 'waiting',
      expiresAt: '2026-11-06T23:00:00.000Z',
      bookingId: null,
      createdAt: '2026-10-17T12:00:00.000Z',
      updatedAt: '2026-10-17T12:05:00.000Z',
    });
  });

  it('a waiting entry reads as expired from its expiry on; other statuses stay', () => {
    const at = entryRow.expiresAt;
    expect(toWaitlistEntry(entryRow, new Date(at.getTime() - 1)).status).toBe('waiting');
    expect(toWaitlistEntry(entryRow, at).status).toBe('expired');
    expect(toWaitlistEntry({ ...entryRow, status: 'cancelled' }, at).status).toBe('cancelled');
    expect(toWaitlistEntry({ ...entryRow, status: 'offered' }, at).status).toBe('offered');
  });

  it('audits ids, expiry and the stored status; never the windows', () => {
    expect(waitlistAuditValues({ ...entryRow, status: 'cancelled' })).toEqual({
      clientId: CLIENT,
      serviceId: SERVICE,
      staffMemberId: null,
      expiresAt: '2026-11-06T23:00:00.000Z',
      status: 'cancelled',
    });
  });
});
