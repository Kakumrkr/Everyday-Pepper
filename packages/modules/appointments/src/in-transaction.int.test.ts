import {
  TenantIdSchema,
  type Booking,
  type Client,
  type MembershipRole,
  type Service,
  type StaffMember,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  findClientsByNameIn,
  ManualClock,
  type Actor,
} from '@pepper/core';
import { addMembership, listAuditEntries, withMember, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BookingAlreadyStartedError,
  BookingNotChangeableError,
  BookingNotFoundError,
  SlotUnavailableError,
} from './errors.js';
import { findAvailabilityIn } from './services/availability.js';
import {
  changeBooking,
  changeBookingIn,
  createBooking,
  createBookingIn,
  getBooking,
  getBookingIn,
  reinstateBookingIn,
} from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { addTimeOffIn, listTimeOffBetweenIn, removeTimeOffIn } from './services/time-off.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The booking services inside a caller's transaction (ADR-0028 §9, ADR-0029): the AI's tools run
// them in the trust layer's transaction, which must stay usable when a time is refused (the
// write runs in a savepoint) so the receipt or the alternatives can still be written and read.
// `reinstateBookingIn` brings back a cancelled booking for Undo, only while its time is free.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:00 in New York (EST).
const NOW = '2026-11-02T12:00:00.000Z';
/** Tuesday 3 November, `HH:MM` in New York (UTC-5). */
const tue = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, (h ?? 0) + 5, m ?? 0)).toISOString();
};

interface Business {
  tenantId: TenantId;
  owner: Actor;
  staff: Actor;
  service: Service;
  jess: StaffMember;
  client: Client;
  clock: ManualClock;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-in-tx-${String(slugs)}`,
    timeZone: 'America/New_York',
    templateId: null,
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const staffId = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffId, role: 'staff' }));
  const owner = actor(ownerId, 'owner');
  const service = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
  });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffId,
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
  const client = await createClient(db, owner, { name: 'Maria Lopez' });
  return {
    tenantId,
    owner,
    staff: actor(staffId, 'staff'),
    service,
    jess,
    client,
    clock: new ManualClock(NOW),
  };
}

const input = (b: Business, startsAt: string) => ({
  clientId: b.client.id,
  serviceId: b.service.id,
  staffMemberId: b.jess.id,
  startsAt,
  notifyClient: false,
});

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch((error: unknown) => error);
}

describe('createBookingIn and changeBookingIn', () => {
  it('refuse a taken time with its 3 nearest alternatives and leave the transaction usable', async () => {
    const b = await newBusiness();
    await createBooking(db, b.owner, input(b, tue('10:00')), { clock: b.clock });

    const after = await withMember(db, b.owner.context, async (tx) => {
      const error = await caught(createBookingIn(tx, b.owner, input(b, tue('10:00')), b));
      expect(error).toBeInstanceOf(SlotUnavailableError);
      expect((error as SlotUnavailableError).alternatives).toHaveLength(3);
      // The transaction still works: a write after the refusal commits with it.
      return createBookingIn(tx, b.owner, input(b, tue('14:00')), b);
    });
    expect((await getBooking(db, b.owner, after.id)).startsAt).toBe(tue('14:00'));
  });

  it('turn an overlap the database refuses (an override) into alternatives, in a savepoint', async () => {
    const b = await newBusiness();
    await createBooking(db, b.owner, input(b, tue('10:00')), { clock: b.clock });

    const kept = await withMember(db, b.owner.context, async (tx) => {
      const forced = { ...input(b, tue('10:30')), override: true };
      const error = await caught(createBookingIn(tx, b.owner, forced, b));
      expect(error).toBeInstanceOf(SlotUnavailableError);
      return createBookingIn(tx, b.owner, input(b, tue('15:00')), b);
    });
    expect(kept.status).toBe('confirmed');
  });

  it('refuse a move onto a taken time without spoiling the transaction', async () => {
    const b = await newBusiness();
    await createBooking(db, b.owner, input(b, tue('10:00')), { clock: b.clock });
    const other = await createBooking(db, b.owner, input(b, tue('13:00')), { clock: b.clock });

    const moved = await withMember(db, b.owner.context, async (tx) => {
      const forced = { startsAt: tue('10:00'), override: true, notifyClient: false };
      const error = await caught(changeBookingIn(tx, b.owner, other.id, forced, b));
      expect(error).toBeInstanceOf(SlotUnavailableError);
      return changeBookingIn(tx, b.owner, other.id, { startsAt: tue('15:00') }, b);
    });
    expect(moved.startsAt).toBe(tue('15:00'));
  });

  it('roll back with the caller: nothing is left when the outer transaction fails', async () => {
    const b = await newBusiness();
    let made: Booking | undefined;
    const error = await caught(
      withMember(db, b.owner.context, async (tx) => {
        made = await createBookingIn(tx, b.owner, input(b, tue('10:00')), b);
        throw new Error('dry run');
      }),
    );
    expect(error).toEqual(new Error('dry run'));
    expect(made).toBeDefined();
    await expect(getBooking(db, b.owner, made?.id ?? ('' as never))).rejects.toThrow();
  });

  it('let staff read only their own bookings, as the screens do', async () => {
    const b = await newBusiness();
    const own = await createBooking(db, b.owner, input(b, tue('10:00')), { clock: b.clock });
    const seen = await withMember(db, b.staff.context, (tx) => getBookingIn(tx, b.staff, own.id));
    expect(seen.id).toBe(own.id);
  });
});

describe('reinstateBookingIn', () => {
  async function cancelled(b: Business, at = tue('10:00')) {
    const booking = await createBooking(db, b.owner, input(b, at), { clock: b.clock });
    await changeBooking(db, b.owner, booking.id, { status: 'cancelled', notifyClient: false });
    return booking;
  }

  it('brings a cancelled booking back, audited as a change of status', async () => {
    const b = await newBusiness();
    const booking = await cancelled(b);
    const back = await withMember(db, b.owner.context, (tx) =>
      reinstateBookingIn(tx, b.owner, booking.id, b),
    );
    expect(back).toMatchObject({ id: booking.id, status: 'confirmed', startsAt: tue('10:00') });
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(audit[0]).toMatchObject({
      action: 'booking.updated',
      before: { status: 'cancelled' },
      after: { status: 'confirmed' },
    });
  });

  it('refuses when the time was booked since, with alternatives', async () => {
    const b = await newBusiness();
    const booking = await cancelled(b);
    await createBooking(db, b.owner, input(b, tue('10:00')), { clock: b.clock });
    const error = await caught(
      withMember(db, b.owner.context, (tx) => reinstateBookingIn(tx, b.owner, booking.id, b)),
    );
    expect(error).toBeInstanceOf(SlotUnavailableError);
  });

  it('refuses once the appointment has started, and for a booking that is not cancelled', async () => {
    const b = await newBusiness();
    const booking = await cancelled(b);
    const later = { clock: new ManualClock(tue('10:00')) };
    await expect(
      withMember(db, b.owner.context, (tx) => reinstateBookingIn(tx, b.owner, booking.id, later)),
    ).rejects.toBeInstanceOf(BookingAlreadyStartedError);

    const live = await createBooking(db, b.owner, input(b, tue('14:00')), { clock: b.clock });
    await expect(
      withMember(db, b.owner.context, (tx) => reinstateBookingIn(tx, b.owner, live.id, b)),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
  });

  it("hides another business's booking", async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    const booking = await cancelled(b);
    await expect(
      withMember(db, other.owner.context, (tx) =>
        reinstateBookingIn(tx, other.owner, booking.id, other),
      ),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
  });
});

describe('time off and availability in a transaction', () => {
  it('adds, lists and removes blocked time; a block removes the slots it covers', async () => {
    const b = await newBusiness();
    const day = { from: new Date(tue('00:00')), to: new Date(tue('23:59')) };
    await withMember(db, b.owner.context, async (tx) => {
      const query = {
        serviceId: b.service.id,
        from: tue('09:00'),
        to: tue('12:00'),
      };
      const before = await findAvailabilityIn(tx, b.owner, query, b);
      const entry = await addTimeOffIn(tx, b.staff, b.jess.id, {
        startsAt: tue('09:00'),
        endsAt: tue('12:00'),
      });
      expect(await findAvailabilityIn(tx, b.owner, query, b)).toEqual([]);
      expect(before.length).toBeGreaterThan(0);
      expect(await listTimeOffBetweenIn(tx, b.staff, day)).toEqual([entry]);
      await removeTimeOffIn(tx, b.staff, b.jess.id, entry.id);
      expect(await listTimeOffBetweenIn(tx, b.staff, day)).toEqual([]);
    });
  });
});

describe('findClientsByNameIn', () => {
  it('matches names only, so an email address finds no one', async () => {
    const b = await newBusiness();
    await createClient(db, b.owner, { name: 'Sara Kim', email: 'sara.kim@example.test' });
    await withMember(db, b.owner.context, async (tx) => {
      const byName = await findClientsByNameIn(tx, b.owner, { search: 'sara', limit: 10 });
      expect(byName.map((c) => c.name)).toEqual(['Sara Kim']);
      expect(await findClientsByNameIn(tx, b.owner, { search: 'example', limit: 10 })).toEqual([]);
      expect(await findClientsByNameIn(tx, b.owner, { search: 'sara.kim@', limit: 10 })).toEqual(
        [],
      );
    });
  });
});
