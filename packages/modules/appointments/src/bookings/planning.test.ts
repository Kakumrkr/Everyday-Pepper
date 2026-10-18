import {
  ServiceIdSchema,
  StaffMemberIdSchema,
  type Rule,
  type WaitlistWindow,
} from '@pepper/contracts';
import type { Occupancy, TimeOffRow } from '@pepper/db';
import { describe, expect, it } from 'vitest';
import type { Slot } from '../availability/engine.js';
import {
  ALTERNATIVES_SEARCH_DAYS,
  alternativesRange,
  existingBookingOf,
  nearestSlots,
  staffAvailabilityOf,
  toAvailableSlot,
  waitlistExpiry,
} from './planning.js';

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
const SERVICE = ServiceIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197');
const JESS = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198');
const MARCO = StaffMemberIdSchema.parse('0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819a');
const BOOKING = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819b';
const OTHER_BOOKING = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819c';
const DAY_MS = 86_400_000;
const t = (iso: string) => Date.parse(iso);

function occupancy(bookingId: string, staffMemberId: string, start: string): Occupancy {
  // A 60-minute appointment with 15 minutes before and 10 after.
  const startsAt = new Date(start);
  return {
    bookingId,
    staffMemberId,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3_600_000),
    occupiedFrom: new Date(startsAt.getTime() - 15 * 60_000),
    occupiedTo: new Date(startsAt.getTime() + 70 * 60_000),
  };
}

describe('existingBookingOf', () => {
  it('reads the buffers back from the occupied time', () => {
    expect(existingBookingOf(occupancy(BOOKING, JESS, '2026-11-02T14:00:00Z'))).toEqual({
      start: t('2026-11-02T14:00:00Z'),
      end: t('2026-11-02T15:00:00Z'),
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 10,
    });
  });
});

describe('staffAvailabilityOf', () => {
  const timeOff = (staffMemberId: string): TimeOffRow => ({
    id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819d',
    tenantId: TENANT,
    staffMemberId,
    startsAt: new Date('2026-11-03T13:00:00Z'),
    endsAt: new Date('2026-11-03T17:00:00Z'),
    createdByUserId: null,
    createdAt: new Date('2026-10-17T12:00:00Z'),
  });
  const rules: Rule[] = [
    { type: 'slot_interval', version: 1, staffMemberId: null, params: { minutes: 30 } },
    { type: 'minimum_notice', version: 1, staffMemberId: JESS, params: { minutes: 0 } },
    { type: 'minimum_notice', version: 1, staffMemberId: MARCO, params: { minutes: 1440 } },
  ];
  const rows = {
    staff: { id: JESS, active: true, serviceIds: [SERVICE] },
    hours: [
      { staffMemberId: JESS, weekday: 1, startMinute: 540, endMinute: 1020 },
      { staffMemberId: MARCO, weekday: 2, startMinute: 600, endMinute: 900 },
    ],
    timeOff: [timeOff(JESS), timeOff(MARCO)],
    occupancy: [
      occupancy(BOOKING, JESS, '2026-11-02T14:00:00Z'),
      occupancy(OTHER_BOOKING, JESS, '2026-11-02T16:00:00Z'),
      occupancy('0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819e', MARCO, '2026-11-02T14:00:00Z'),
    ],
    rules,
  };

  it("picks the staff member's own rows and rules", () => {
    const availability = staffAvailabilityOf(rows);
    expect(availability).toMatchObject({
      staffMemberId: JESS,
      active: true,
      serviceIds: [SERVICE],
      hours: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
      timeOff: [{ start: t('2026-11-03T13:00:00Z'), end: t('2026-11-03T17:00:00Z') }],
      busy: [],
    });
    expect(availability.bookings.map((b) => b.start)).toEqual([
      t('2026-11-02T14:00:00Z'),
      t('2026-11-02T16:00:00Z'),
    ]);
    expect(availability.rules).toMatchObject({ slotIntervalMinutes: 30, minimumNoticeMinutes: 0 });
  });

  it('leaves out the booking being moved', () => {
    const availability = staffAvailabilityOf({ ...rows, excludeBookingId: BOOKING });
    expect(availability.bookings.map((b) => b.start)).toEqual([t('2026-11-02T16:00:00Z')]);
  });

  it('applies template defaults under the business rules', () => {
    const availability = staffAvailabilityOf({
      ...rows,
      rules: [],
      templateDefaults: { slotIntervalMinutes: 20 },
    });
    expect(availability.rules.slotIntervalMinutes).toBe(20);
  });
});

describe('alternatives', () => {
  const slot = (start: string, staffMemberId = JESS): Slot => ({
    staffMemberId,
    start: t(start),
    end: t(start) + 3_600_000,
  });

  it('searches a week either side, never before now', () => {
    const around = t('2026-11-10T14:00:00Z');
    expect(alternativesRange(around, t('2026-10-01T00:00:00Z'))).toEqual({
      from: around - ALTERNATIVES_SEARCH_DAYS * DAY_MS,
      to: around + ALTERNATIVES_SEARCH_DAYS * DAY_MS,
    });
    const now = t('2026-11-09T09:00:00Z');
    expect(alternativesRange(around, now).from).toBe(now);
  });

  it('takes the nearest slots, earlier first on a tie', () => {
    const slots = [
      slot('2026-11-10T09:00:00Z'),
      slot('2026-11-10T13:00:00Z'),
      slot('2026-11-10T15:00:00Z'),
      slot('2026-11-10T15:30:00Z'),
      slot('2026-11-11T14:00:00Z'),
    ];
    expect(
      nearestSlots(slots, t('2026-11-10T14:00:00Z'), 3).map((s) => new Date(s.start).toISOString()),
    ).toEqual(['2026-11-10T13:00:00.000Z', '2026-11-10T15:00:00.000Z', '2026-11-10T15:30:00.000Z']);
    expect(nearestSlots([], 0, 3)).toEqual([]);
  });

  it('serialises a slot for the api', () => {
    expect(toAvailableSlot(slot('2026-11-10T13:00:00Z'))).toEqual({
      staffMemberId: JESS,
      startsAt: '2026-11-10T13:00:00.000Z',
      endsAt: '2026-11-10T14:00:00.000Z',
    });
  });
});

describe('waitlistExpiry', () => {
  const window = (date: string, start: string, end: string): WaitlistWindow => ({
    date,
    start,
    end,
  });

  it('is the end of the last window in the business time zone', () => {
    const windows = [
      window('2026-11-02', '09:00', '12:00'),
      window('2026-11-06', '15:00', '18:00'),
      window('2026-11-04', '09:00', '20:00'),
    ];
    // 18:00 EST (after the November DST change) is 23:00 UTC.
    expect(new Date(waitlistExpiry(windows, 'America/New_York')).toISOString()).toBe(
      '2026-11-06T23:00:00.000Z',
    );
    expect(new Date(waitlistExpiry(windows, 'America/Los_Angeles')).toISOString()).toBe(
      '2026-11-07T02:00:00.000Z',
    );
  });

  it('a window to 24:00 ends at the next local midnight', () => {
    expect(
      new Date(
        waitlistExpiry([window('2026-10-30', '09:00', '24:00')], 'America/Chicago'),
      ).toISOString(),
    ).toBe('2026-10-31T05:00:00.000Z');
  });

  it('needs a window', () => {
    expect(() => waitlistExpiry([], 'America/New_York')).toThrow(RangeError);
  });
});
