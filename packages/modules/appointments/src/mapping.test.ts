import type { ServiceRow, StaffMemberRecord, TimeOffRow } from '@floty/db';
import { describe, expect, it } from 'vitest';
import {
  hoursToMinutes,
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
  color: '#be2759',
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
      color: '#be2759',
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
