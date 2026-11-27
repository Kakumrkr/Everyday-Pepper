import {
  BookingIdSchema,
  ClientContactSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  WaitlistEntryIdSchema,
  type BookingId,
  type ClientId,
  type ServiceId,
  type StaffMemberId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import {
  BookingIdempotencyKeyTakenError,
  BookingOverlapError,
  ClientEmailTakenError,
} from './errors.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import {
  cancelWaitlistEntry,
  findBooking,
  findBookingByIdempotencyKey,
  insertBooking,
  insertWaitlistEntry,
  clientStandingIn,
  listBookings,
  listClientBookings,
  listOccupancy,
  listWaitlistEntries,
  lockBooking,
  lockWaitlistEntry,
  moveBooking,
  setBookingStatus,
  type NewBooking,
} from './repositories/bookings.js';
import {
  markBookingClientConfirmed,
  markBookingConfirmAsked,
} from './repositories/booking-texts.js';
import {
  findClient,
  findClientsByContact,
  insertClient,
  listClients,
  updateClient,
} from './repositories/clients.js';
import { addMembership, deleteMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { setTransactionClientContact, withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Clients, bookings, their occupied time and the waitlist against real Postgres (ADR-0017):
// the exclusion constraint against double booking (also under concurrency), the occupancy
// trigger, references that stay inside a business, and the member scope that limits staff to
// their own records at the RLS level (AC-W9-1). Tenant isolation is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase({ maxConnections: 10 });
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const at = (iso: string) => new Date(iso);

interface Business {
  tenant: TenantId;
  service: ServiceId;
  jess: StaffMemberId;
  marco: StaffMemberId;
  client: ClientId;
}

/** A business with a 60-minute service (10 minutes' clean-up after), two staff, one client. */
async function newBusiness(): Promise<Business> {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Juniper',
    slug: `juniper-book-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenant = TenantIdSchema.parse(created.id);
  return withTenant(db, tenant, async (tx) => {
    const service = await insertService(tx, {
      name: 'Haircut',
      category: null,
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      priceFromCents: 6500,
      priceToCents: null,
      active: true,
    });
    const staff = (displayName: string) =>
      insertStaffMember(tx, { displayName, color: '#2a7230', active: true, membershipId: null });
    const client = await insertClient(tx, {
      name: 'Maria Lopez',
      email: 'maria@example.test',
      phone: null,
      source: 'team',
    });
    return {
      tenant,
      service: ServiceIdSchema.parse(service.id),
      jess: StaffMemberIdSchema.parse((await staff('Jess')).id),
      marco: StaffMemberIdSchema.parse((await staff('Marco')).id),
      client: ClientIdSchema.parse(client.id),
    };
  });
}

/** A confirmed 60-minute booking with 10 minutes' buffer after, starting at `startsAt`. */
function booking(b: Business, staffMemberId: StaffMemberId, startsAt: string): NewBooking {
  const start = at(startsAt);
  return {
    clientId: b.client,
    serviceId: b.service,
    staffMemberId,
    startsAt: start,
    endsAt: new Date(start.getTime() + 60 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: 6500,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  };
}

function book(b: Business, input: NewBooking) {
  return withTenant(db, b.tenant, (tx) => insertBooking(tx, input));
}

describe('the exclusion constraint', () => {
  let b: Business;
  beforeAll(async () => {
    b = await newBusiness();
  });

  it("refuses a booking that overlaps another of the staff member's, buffers included", async () => {
    await book(b, booking(b, b.jess, '2026-11-02T14:00:00Z'));
    // 15:05 starts inside the first booking's 10-minute clean-up (15:00–15:10).
    await expect(book(b, booking(b, b.jess, '2026-11-02T15:05:00Z'))).rejects.toBeInstanceOf(
      BookingOverlapError,
    );
    await expect(book(b, booking(b, b.jess, '2026-11-02T13:30:00Z'))).rejects.toBeInstanceOf(
      BookingOverlapError,
    );
  });

  it('allows a booking that starts when the buffer ends, and the same time with someone else', async () => {
    await book(b, booking(b, b.jess, '2026-11-03T14:00:00Z'));
    await expect(book(b, booking(b, b.jess, '2026-11-03T15:10:00Z'))).resolves.toBeDefined();
    await expect(book(b, booking(b, b.marco, '2026-11-03T14:00:00Z'))).resolves.toBeDefined();
  });

  it('a buffer before also counts', async () => {
    await book(b, booking(b, b.jess, '2026-11-04T14:00:00Z'));
    const withPrep = { ...booking(b, b.jess, '2026-11-04T15:15:00Z'), bufferBeforeMinutes: 10 };
    await expect(book(b, withPrep)).rejects.toBeInstanceOf(BookingOverlapError);
    await expect(
      book(b, {
        ...withPrep,
        startsAt: at('2026-11-04T15:20:00Z'),
        endsAt: at('2026-11-04T16:20:00Z'),
      }),
    ).resolves.toBeDefined();
  });

  it('cancelling frees the time; completed and no-show keep it', async () => {
    const first = await book(b, booking(b, b.jess, '2026-11-05T14:00:00Z'));
    const id = BookingIdSchema.parse(first.id);
    await withTenant(db, b.tenant, (tx) => setBookingStatus(tx, id, 'completed', new Date()));
    await expect(book(b, booking(b, b.jess, '2026-11-05T14:30:00Z'))).rejects.toBeInstanceOf(
      BookingOverlapError,
    );
    await withTenant(db, b.tenant, (tx) => setBookingStatus(tx, id, 'no_show', new Date()));
    await expect(book(b, booking(b, b.jess, '2026-11-05T14:30:00Z'))).rejects.toBeInstanceOf(
      BookingOverlapError,
    );
    await withTenant(db, b.tenant, (tx) => setBookingStatus(tx, id, 'cancelled', new Date()));
    await expect(book(b, booking(b, b.jess, '2026-11-05T14:30:00Z'))).resolves.toBeDefined();
  });

  it('a cancel records its first time; any other status clears it (S77)', async () => {
    const row = await book(b, booking(b, b.jess, '2026-11-05T18:00:00Z'));
    const id = BookingIdSchema.parse(row.id);
    const first = new Date('2026-11-04T09:00:00Z');
    const cancelled = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'cancelled', first),
    );
    expect(cancelled?.cancelledAt?.toISOString()).toBe(first.toISOString());
    const again = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'cancelled', new Date('2026-11-04T10:00:00Z')),
    );
    expect(again?.cancelledAt?.toISOString()).toBe(first.toISOString());
    const back = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'confirmed', new Date('2026-11-04T11:00:00Z')),
    );
    expect(back?.cancelledAt).toBeNull();
    // The database keeps the column and the status in step whatever path writes them.
    await withTenant(db, b.tenant, async (tx) => {
      await tx.execute(sql`UPDATE bookings SET cancelled_at = now() WHERE id = ${id}`);
      const { rows: kept } = await tx.execute<{ at: Date | null }>(
        sql`SELECT cancelled_at AS at FROM bookings WHERE id = ${id}`,
      );
      expect(kept[0]?.at).toBeNull();
      await tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${id}`);
      const { rows: raw } = await tx.execute<{ at: Date | null }>(
        sql`SELECT cancelled_at AS at FROM bookings WHERE id = ${id}`,
      );
      expect(raw[0]?.at).not.toBeNull();
    });
  });

  it('a cancel records who cancelled, keeps the first, and other statuses clear it (S78, AC-X-200)', async () => {
    const row = await book(b, booking(b, b.jess, '2026-11-05T20:00:00Z'));
    const id = BookingIdSchema.parse(row.id);
    const when = new Date('2026-11-04T09:00:00Z');
    const byClient = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'cancelled', when, 'client'),
    );
    expect(byClient?.cancelledBy).toBe('client');
    const again = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'cancelled', when, 'business'),
    );
    expect(again?.cancelledBy).toBe('client');
    const back = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'confirmed', when),
    );
    expect(back?.cancelledBy).toBeNull();
    const byBusiness = await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, id, 'cancelled', when),
    );
    expect(byBusiness?.cancelledBy).toBe('business');
    await withTenant(db, b.tenant, async (tx) => {
      // Raw SQL back to confirmed clears it too, and an unknown value is refused.
      await tx.execute(sql`UPDATE bookings SET status = 'confirmed' WHERE id = ${id}`);
      const { rows } = await tx.execute<{ by: string | null }>(
        sql`SELECT cancelled_by AS by FROM bookings WHERE id = ${id}`,
      );
      expect(rows[0]?.by).toBeNull();
    });
    await expect(
      withTenant(db, b.tenant, (tx) =>
        tx.execute(
          sql`UPDATE bookings SET status = 'cancelled', cancelled_by = 'staff' WHERE id = ${id}`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('a move clears the client’s confirm, how they confirmed and the ask (S78)', async () => {
    const row = await book(b, booking(b, b.jess, '2026-11-07T15:00:00Z'));
    const id = BookingIdSchema.parse(row.id);
    const now = new Date('2026-11-04T09:00:00Z');
    await withTenant(db, b.tenant, async (tx) => {
      await markBookingConfirmAsked(tx, id, now);
      const marked = await markBookingClientConfirmed(tx, id, now, 'link');
      expect(marked).toMatchObject({ clientConfirmedVia: 'link', confirmAskedAt: now });
    });
    const moved = await withTenant(db, b.tenant, (tx) =>
      moveBooking(tx, id, {
        staffMemberId: b.jess,
        startsAt: at('2026-11-07T17:00:00Z'),
        endsAt: at('2026-11-07T18:00:00Z'),
        overridden: false,
      }),
    );
    expect(moved).toMatchObject({
      clientConfirmedAt: null,
      clientConfirmedVia: null,
      confirmAskedAt: null,
    });
  });

  it('refuses a move onto a taken time; a move within its own time is fine', async () => {
    await book(b, booking(b, b.marco, '2026-11-06T14:00:00Z'));
    const second = await book(b, booking(b, b.marco, '2026-11-06T16:00:00Z'));
    const id = BookingIdSchema.parse(second.id);
    await expect(
      withTenant(db, b.tenant, (tx) =>
        moveBooking(tx, id, {
          staffMemberId: b.marco,
          startsAt: at('2026-11-06T14:30:00Z'),
          endsAt: at('2026-11-06T15:30:00Z'),
          overridden: false,
        }),
      ),
    ).rejects.toBeInstanceOf(BookingOverlapError);
    const moved = await withTenant(db, b.tenant, (tx) =>
      moveBooking(tx, id, {
        staffMemberId: b.marco,
        startsAt: at('2026-11-06T16:30:00Z'),
        endsAt: at('2026-11-06T17:30:00Z'),
        overridden: true,
      }),
    );
    expect(moved).toMatchObject({ startsAt: at('2026-11-06T16:30:00Z'), overridden: true });
  });

  it('exactly one of many concurrent bookings of one time succeeds', async () => {
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        // Different starts within one hour: every pair overlaps.
        book(b, booking(b, b.jess, `2026-11-09T14:${String(i * 5).padStart(2, '0')}:00Z`)),
      ),
    );
    const won = attempts.filter((a) => a.status === 'fulfilled');
    const lost = attempts.filter((a) => a.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);
    for (const attempt of lost) expect(attempt.reason).toBeInstanceOf(BookingOverlapError);
  });
});

describe('booking_occupancy', () => {
  it('holds the occupied time of each active booking, kept in step by the trigger', async () => {
    const b = await newBusiness();
    const first = await book(b, {
      ...booking(b, b.jess, '2026-11-02T14:00:00Z'),
      bufferBeforeMinutes: 15,
    });
    const id = BookingIdSchema.parse(first.id);
    const range = { from: at('2026-11-02T00:00:00Z'), to: at('2026-11-03T00:00:00Z') };
    const occupancy = () => withTenant(db, b.tenant, (tx) => listOccupancy(tx, range));

    expect(await occupancy()).toEqual([
      {
        bookingId: first.id,
        staffMemberId: b.jess,
        startsAt: at('2026-11-02T14:00:00Z'),
        endsAt: at('2026-11-02T15:00:00Z'),
        occupiedFrom: at('2026-11-02T13:45:00Z'),
        occupiedTo: at('2026-11-02T15:10:00Z'),
      },
    ]);

    await withTenant(db, b.tenant, (tx) =>
      moveBooking(tx, id, {
        staffMemberId: b.marco,
        startsAt: at('2026-11-02T18:00:00Z'),
        endsAt: at('2026-11-02T19:00:00Z'),
        overridden: false,
      }),
    );
    expect(await occupancy()).toMatchObject([
      { bookingId: first.id, staffMemberId: b.marco, occupiedFrom: at('2026-11-02T17:45:00Z') },
    ]);

    await withTenant(db, b.tenant, (tx) => setBookingStatus(tx, id, 'cancelled', new Date()));
    expect(await occupancy()).toEqual([]);
  });

  it('filters by range (half-open) and staff member', async () => {
    const b = await newBusiness();
    await book(b, booking(b, b.jess, '2026-11-02T14:00:00Z'));
    await book(b, booking(b, b.marco, '2026-11-02T16:00:00Z'));
    const list = (from: string, to: string, staffMemberIds?: StaffMemberId[]) =>
      withTenant(db, b.tenant, (tx) =>
        listOccupancy(tx, {
          from: at(from),
          to: at(to),
          ...(staffMemberIds && { staffMemberIds }),
        }),
      );
    // Jess's ends (with buffer) at 15:10; Marco's starts at 16:00.
    expect(await list('2026-11-02T15:10:00Z', '2026-11-02T16:00:00Z')).toEqual([]);
    expect(await list('2026-11-02T15:09:00Z', '2026-11-02T16:01:00Z')).toHaveLength(2);
    expect(
      (await list('2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z', [b.marco])).map(
        (o) => o.staffMemberId,
      ),
    ).toEqual([b.marco]);
    expect(await list('2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z', [])).toEqual([]);
  });

  it('returns at most `limit` rows, earliest first', async () => {
    const b = await newBusiness();
    await book(b, booking(b, b.marco, '2026-11-02T16:00:00Z'));
    const early = await book(b, booking(b, b.jess, '2026-11-02T14:00:00Z'));
    const rows = await withTenant(db, b.tenant, (tx) =>
      listOccupancy(tx, {
        from: at('2026-11-02T00:00:00Z'),
        to: at('2026-11-03T00:00:00Z'),
        limit: 1,
      }),
    );
    expect(rows.map((o) => o.bookingId)).toEqual([early.id]);
  });
});

describe('bookings', () => {
  it('lists bookings overlapping a range by start, by staff member and status', async () => {
    const b = await newBusiness();
    const late = await book(b, booking(b, b.jess, '2026-11-02T16:00:00Z'));
    const early = await book(b, booking(b, b.marco, '2026-11-02T14:00:00Z'));
    await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, BookingIdSchema.parse(early.id), 'cancelled', new Date()),
    );
    const list = (options: Partial<Parameters<typeof listBookings>[1]> = {}) =>
      withTenant(db, b.tenant, (tx) =>
        listBookings(tx, {
          from: at('2026-11-02T14:30:00Z'),
          to: at('2026-11-02T16:00:01Z'),
          ...options,
        }),
      );
    expect((await list()).map((r) => r.id)).toEqual([early.id, late.id]);
    expect((await list({ staffMemberId: b.jess })).map((r) => r.id)).toEqual([late.id]);
    expect((await list({ status: 'cancelled' })).map((r) => r.id)).toEqual([early.id]);
    // The appointment's own time counts here (15:00 end), not its buffer.
    expect(
      await list({ from: at('2026-11-02T15:00:00Z'), to: at('2026-11-02T16:00:00Z') }),
    ).toEqual([]);
    expect((await list({ limit: 1 })).map((r) => r.id)).toEqual([early.id]);
  });

  it("lists one client's bookings (S16: a client's visits)", async () => {
    const b = await newBusiness();
    const lee = await withTenant(db, b.tenant, (tx) =>
      insertClient(tx, { name: 'Lee', email: null, phone: null, source: 'team' }),
    );
    const maria = await book(b, booking(b, b.jess, '2026-11-02T14:00:00Z'));
    const lees = await book(b, {
      ...booking(b, b.marco, '2026-11-02T14:00:00Z'),
      clientId: ClientIdSchema.parse(lee.id),
    });
    const range = { from: at('2026-11-01T00:00:00Z'), to: at('2026-11-03T00:00:00Z') };
    const of = (clientId: ClientId) =>
      withTenant(db, b.tenant, (tx) => listBookings(tx, { ...range, clientId }));
    expect((await of(b.client)).map((r) => r.id)).toEqual([maria.id]);
    expect((await of(ClientIdSchema.parse(lee.id))).map((r) => r.id)).toEqual([lees.id]);
  });

  it("counts a client's ended visits and recent no-shows (S67, AC-X-126)", async () => {
    const b = await newBusiness();
    const now = at('2026-11-24T15:00:00Z');
    const since = at('2025-11-24T15:00:00Z');
    const standing = () =>
      withTenant(db, b.tenant, (tx) => clientStandingIn(tx, { clientId: b.client, now, since }));
    expect(await standing()).toEqual({ endedVisits: 0, recentNoShows: 0 });
    // Upcoming, cancelled and still running visits count for neither.
    await book(b, booking(b, b.jess, '2026-12-01T14:00:00Z'));
    const cancelled = await book(b, booking(b, b.jess, '2026-11-01T14:00:00Z'));
    await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, BookingIdSchema.parse(cancelled.id), 'cancelled', new Date()),
    );
    await book(b, booking(b, b.marco, '2026-11-24T14:30:00Z'));
    expect(await standing()).toEqual({ endedVisits: 0, recentNoShows: 0 });
    // A confirmed visit that has ended counts, as a completed one does.
    await book(b, booking(b, b.jess, '2026-10-01T14:00:00Z'));
    const done = await book(b, booking(b, b.jess, '2026-09-01T14:00:00Z'));
    await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, BookingIdSchema.parse(done.id), 'completed', new Date()),
    );
    expect(await standing()).toEqual({ endedVisits: 2, recentNoShows: 0 });
    // A no-show inside the 12 months counts; an older one doesn't.
    const old = await book(b, booking(b, b.jess, '2025-06-01T14:00:00Z'));
    const recent = await book(b, booking(b, b.jess, '2026-08-01T14:00:00Z'));
    await withTenant(db, b.tenant, async (tx) => {
      await setBookingStatus(tx, BookingIdSchema.parse(old.id), 'no_show', new Date());
      await setBookingStatus(tx, BookingIdSchema.parse(recent.id), 'no_show', new Date());
    });
    expect(await standing()).toEqual({ endedVisits: 2, recentNoShows: 1 });
    // Another client's visits are theirs.
    const lee = await withTenant(db, b.tenant, (tx) =>
      insertClient(tx, { name: 'Lee', email: null, phone: null, source: 'team' }),
    );
    expect(
      await withTenant(db, b.tenant, (tx) =>
        clientStandingIn(tx, { clientId: ClientIdSchema.parse(lee.id), now, since }),
      ),
    ).toEqual({ endedVisits: 0, recentNoShows: 0 });
  });

  it("lists a client's bookings either side of a moment, nearest first (S26b)", async () => {
    const b = await newBusiness();
    const old = await book(b, booking(b, b.jess, '2026-08-03T14:00:00Z'));
    const last = await book(b, booking(b, b.marco, '2026-10-30T14:00:00Z'));
    const next = await book(b, booking(b, b.jess, '2026-11-05T14:00:00Z'));
    const later = await book(b, booking(b, b.jess, '2027-03-01T15:00:00Z'));
    const dropped = await book(b, booking(b, b.marco, '2026-11-06T14:00:00Z'));
    await withTenant(db, b.tenant, (tx) =>
      setBookingStatus(tx, BookingIdSchema.parse(dropped.id), 'cancelled', new Date()),
    );
    const of = (options: Partial<Parameters<typeof listClientBookings>[1]>) =>
      withTenant(db, b.tenant, async (tx) =>
        (
          await listClientBookings(tx, {
            clientId: b.client,
            now: at('2026-11-02T12:00:00Z'),
            direction: 'after',
            limit: 5,
            ...options,
          })
        ).map((r) => r.id),
      );
    // No window: months either side count.
    expect(await of({})).toEqual([next.id, dropped.id, later.id]);
    expect(await of({ excludeCancelled: true })).toEqual([next.id, later.id]);
    expect(await of({ direction: 'before' })).toEqual([last.id, old.id]);
    expect(await of({ direction: 'before', limit: 1 })).toEqual([last.id]);
    expect(await of({ staffMemberId: b.marco })).toEqual([dropped.id]);
    // An appointment under way has started: it is recent, not upcoming.
    expect(await of({ now: at('2026-11-05T14:30:00Z') })).toEqual([dropped.id, later.id]);
  });

  it('finds and locks by id, and finds by idempotency key', async () => {
    const b = await newBusiness();
    const row = await book(b, {
      ...booking(b, b.jess, '2026-11-02T14:00:00Z'),
      idempotencyKey: 'ai-run-0001',
    });
    const id = BookingIdSchema.parse(row.id);
    await withTenant(db, b.tenant, async (tx) => {
      expect(await findBooking(tx, id)).toEqual(row);
      expect(await lockBooking(tx, id)).toEqual(row);
      expect(await findBookingByIdempotencyKey(tx, 'ai-run-0001')).toEqual(row);
      expect(await findBookingByIdempotencyKey(tx, 'ai-run-0002')).toBeUndefined();
    });
  });

  it('an idempotency key is unique within a business, not across businesses', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    const keyed = (biz: Business, startsAt: string) => ({
      ...booking(biz, biz.jess, startsAt),
      idempotencyKey: 'same-key-123',
    });
    await book(b, keyed(b, '2026-11-02T14:00:00Z'));
    await expect(book(b, keyed(b, '2026-11-02T18:00:00Z'))).rejects.toBeInstanceOf(
      BookingIdempotencyKeyTakenError,
    );
    await expect(book(other, keyed(other, '2026-11-02T14:00:00Z'))).resolves.toBeDefined();
  });

  it("refuses another business's client, service or staff member (23503)", async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    for (const foreign of [
      { clientId: other.client },
      { serviceId: other.service },
      { staffMemberId: other.jess },
    ]) {
      const error = await book(b, {
        ...booking(b, b.jess, '2026-11-02T14:00:00Z'),
        ...foreign,
      }).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('23503');
    }
  });

  it.each([
    ['a booking shorter than 5 minutes', { endsAt: at('2026-11-02T14:04:00Z') }],
    ['a booking longer than 12 hours', { endsAt: at('2026-11-03T02:01:00Z') }],
    ['an end before the start', { endsAt: at('2026-11-02T13:00:00Z') }],
    ['a buffer over 240 minutes', { bufferAfterMinutes: 241 }],
    ['a negative price', { priceFromCents: -1 }],
  ])('the database refuses %s (23514)', async (_label, change) => {
    const b = await newBusiness();
    const error = await book(b, { ...booking(b, b.jess, '2026-11-02T14:00:00Z'), ...change }).catch(
      (e: unknown) => e,
    );
    expect(sqlState(error)).toBe('23514');
  });

  it.each([
    ['an unknown status', "status = 'pending'"],
    ['an unknown source', "source = 'phone'"],
    ['a malformed idempotency key', "idempotency_key = 'no spaces allowed'"],
  ])('the database refuses %s (23514)', async (_label, assignment) => {
    const b = await newBusiness();
    const row = await book(b, booking(b, b.jess, '2026-11-02T14:00:00Z'));
    const error = await withTenant(db, b.tenant, (tx) =>
      tx.execute(sql.raw(`UPDATE bookings SET ${assignment} WHERE id = '${row.id}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('clients', () => {
  it('one client per email in a business; lists by name with a search', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    await expect(
      withTenant(db, b.tenant, (tx) =>
        insertClient(tx, {
          name: 'Maria L',
          email: 'MARIA@example.test',
          phone: null,
          source: 'ai',
        }),
      ),
    ).rejects.toBeInstanceOf(ClientEmailTakenError);
    // Every test business has a client with this email (newBusiness): another business may.
    expect(await withTenant(db, other.tenant, (tx) => findClient(tx, other.client))).toMatchObject({
      email: 'maria@example.test',
    });
    await withTenant(db, b.tenant, async (tx) => {
      await insertClient(tx, {
        name: 'ana Ruiz',
        email: null,
        phone: '+15551234567',
        source: 'team',
      });
      await insertClient(tx, { name: 'Zoe 100%', email: null, phone: null, source: 'import' });
      const names = async (search?: string) =>
        (await listClients(tx, { search, limit: 50 })).map((c) => c.name);
      expect(await names()).toEqual(['ana Ruiz', 'Maria Lopez', 'Zoe 100%']);
      expect(await names('MAR')).toEqual(['Maria Lopez']);
      expect(await names('example.test')).toEqual(['Maria Lopez']);
      // % and _ match themselves, not anything.
      expect(await names('%')).toEqual(['Zoe 100%']);
      expect(await names('_')).toEqual([]);
      expect(await listClients(tx, { limit: 1 })).toHaveLength(1);
      expect(await findClient(tx, b.client)).toMatchObject({ name: 'Maria Lopez', source: 'team' });
    });
  });

  it('replaces a client’s details; an email another client has is refused; another business’s client is not found', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    await withTenant(db, b.tenant, async (tx) => {
      const lee = await insertClient(tx, {
        name: 'Lee',
        email: 'lee@example.test',
        phone: null,
        source: 'import',
      });
      const updated = await updateClient(tx, b.client, {
        name: 'Maria L.',
        email: 'MARIA.L@example.test',
        phone: '+15551234567',
      });
      expect(updated).toMatchObject({
        name: 'Maria L.',
        email: 'maria.l@example.test',
        phone: '+15551234567',
        source: 'team',
      });
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(
        updated?.createdAt.getTime() ?? 0,
      );
      expect(await findClient(tx, ClientIdSchema.parse(lee.id))).toMatchObject({
        source: 'import',
      });
    });
    await expect(
      withTenant(db, b.tenant, (tx) =>
        updateClient(tx, b.client, { name: 'Maria', email: 'lee@example.test', phone: null }),
      ),
    ).rejects.toBeInstanceOf(ClientEmailTakenError);
    expect(
      await withTenant(db, b.tenant, (tx) =>
        updateClient(tx, other.client, { name: 'Taken over', email: null, phone: null }),
      ),
    ).toBeUndefined();
    expect(await withTenant(db, other.tenant, (tx) => findClient(tx, other.client))).toMatchObject({
      name: 'Maria Lopez',
    });
  });

  it.each([
    ['an email that is not lowercase', "email = 'Maria@example.test'"],
    ['a phone number not in E.164 form', "phone = '555-1234'"],
    ['an unknown source', "source = 'phone'"],
    ['an empty name', "name = ''"],
  ])('the database refuses %s (23514)', async (_label, assignment) => {
    const b = await newBusiness();
    const error = await withTenant(db, b.tenant, (tx) =>
      tx.execute(sql.raw(`UPDATE clients SET ${assignment} WHERE id = '${b.client}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('waitlist entries', () => {
  it('lists open entries by when they were added; cancelled and expired ones only with all', async () => {
    const b = await newBusiness();
    const creator = await insertUser(db);
    const entry = (expiresAt: string) =>
      withTenant(db, b.tenant, (tx) =>
        insertWaitlistEntry(tx, {
          clientId: b.client,
          serviceId: b.service,
          staffMemberId: null,
          windows: [{ date: '2026-11-06', start: '09:00', end: '12:00' }],
          expiresAt: at(expiresAt),
          createdBy: creator,
        }),
      );
    const first = await entry('2026-11-06T17:00:00Z');
    const expired = await entry('2026-11-01T17:00:00Z');
    const cancelled = await entry('2026-11-06T17:00:00Z');
    const now = at('2026-11-02T12:00:00Z');
    await withTenant(db, b.tenant, async (tx) => {
      const id = WaitlistEntryIdSchema.parse(cancelled.id);
      expect(await lockWaitlistEntry(tx, id)).toMatchObject({ status: 'waiting' });
      expect(await cancelWaitlistEntry(tx, id)).toMatchObject({ status: 'cancelled' });
      const ids = async (all: boolean) =>
        (await listWaitlistEntries(tx, { now, all, limit: 10 })).map((e) => e.id);
      expect(await ids(false)).toEqual([first.id]);
      expect(await ids(true)).toEqual([first.id, expired.id, cancelled.id]);
      expect(
        await listWaitlistEntries(tx, { now, all: true, serviceId: b.service, limit: 2 }),
      ).toHaveLength(2);
    });
  });

  it.each([
    ['booked without a booking', "status = 'booked'"],
    ['an unknown status', "status = 'expired'"],
    ['no windows', "windows = '[]'::jsonb"],
    ['windows that are not a list', `windows = '{"date":"2026-11-06"}'::jsonb`],
  ])('the database refuses %s (23514)', async (_label, assignment) => {
    const b = await newBusiness();
    const row = await withTenant(db, b.tenant, async (tx) =>
      insertWaitlistEntry(tx, {
        clientId: b.client,
        serviceId: b.service,
        staffMemberId: b.jess,
        windows: [{ date: '2026-11-06', start: '09:00', end: '12:00' }],
        expiresAt: at('2026-11-06T17:00:00Z'),
        createdBy: await insertUser(db),
      }),
    );
    const error = await withTenant(db, b.tenant, (tx) =>
      tx.execute(sql.raw(`UPDATE waitlist_entries SET ${assignment} WHERE id = '${row.id}'`)),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });
});

describe('member scope (AC-W9-1 at the RLS level)', () => {
  // Juniper: Ana owns it, Cara manages it, Jess is staff linked to staff member Jess, Ben is
  // staff without a staff member. Marco is a staff member without a login.
  let b: Business;
  let ana: UserId;
  let cara: UserId;
  let jessUser: UserId;
  let ben: UserId;
  let stranger: UserId;
  let jessBooking: BookingId;
  let marcoBooking: BookingId;
  let marcosClient: ClientId;
  let jessWaitlist: string;
  let anyoneWaitlist: string;

  const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
    withMember(db, { tenantId: b.tenant, userId }, work);
  const rows = (userId: UserId, table: string) =>
    as(userId, async (tx) =>
      (
        await tx.execute<{ id: string }>(sql.raw(`SELECT id::text FROM ${table} ORDER BY id`))
      ).rows.map((r) => r.id),
    );

  beforeAll(async () => {
    b = await newBusiness();
    ana = await insertUser(db, 'Ana');
    cara = await insertUser(db, 'Cara');
    jessUser = await insertUser(db, 'Jess');
    ben = await insertUser(db, 'Ben');
    stranger = await insertUser(db, 'Stranger');
    await withTenant(db, b.tenant, async (tx) => {
      await addMembership(tx, { userId: ana, role: 'owner' });
      await addMembership(tx, { userId: cara, role: 'manager' });
      const jessMembership = await addMembership(tx, { userId: jessUser, role: 'staff' });
      await addMembership(tx, { userId: ben, role: 'staff' });
      await tx.execute(
        sql`UPDATE staff_members SET membership_id = ${jessMembership.id} WHERE id = ${b.jess}`,
      );
      const marcos = await insertClient(tx, {
        name: 'Lee',
        email: null,
        phone: null,
        source: 'team',
      });
      marcosClient = ClientIdSchema.parse(marcos.id);
      jessBooking = BookingIdSchema.parse(
        (await insertBooking(tx, booking(b, b.jess, '2026-11-02T14:00:00Z'))).id,
      );
      marcoBooking = BookingIdSchema.parse(
        (
          await insertBooking(tx, {
            ...booking(b, b.marco, '2026-11-02T14:00:00Z'),
            clientId: marcosClient,
          })
        ).id,
      );
      const waitlist = (staffMemberId: StaffMemberId | null) =>
        insertWaitlistEntry(tx, {
          clientId: marcosClient,
          serviceId: b.service,
          staffMemberId,
          windows: [{ date: '2026-11-06', start: '09:00', end: '12:00' }],
          expiresAt: at('2026-11-06T17:00:00Z'),
          createdBy: ana,
        });
      jessWaitlist = (await waitlist(b.jess)).id;
      anyoneWaitlist = (await waitlist(null)).id;
    });
  });

  it('staff cannot change roles or staff links, so they cannot widen their own scope (S13 review)', async () => {
    const refused = async (statement: SQL) => {
      const error = await as(jessUser, (tx) => tx.execute(statement)).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('42501'); // insufficient_privilege: row-level security
    };
    // Taking over Marco's staff member would show Jess his bookings and clients.
    await refused(sql`UPDATE staff_members SET membership_id = NULL WHERE id = ${b.jess}`);
    await refused(sql`UPDATE staff_members SET active = active WHERE id = ${b.marco}`);
    await refused(
      sql`INSERT INTO staff_members (display_name, color) VALUES ('Jess 2', '#2a7230')`,
    );
    await refused(sql`UPDATE memberships SET role = 'owner' WHERE user_id = ${jessUser}`);
    const deleted = (statement: SQL, userId: UserId) =>
      as(userId, async (tx) => (await tx.execute(statement)).rowCount);
    expect(await deleted(sql`DELETE FROM staff_members`, jessUser)).toBe(0);
    expect(await deleted(sql`DELETE FROM memberships WHERE user_id = ${ben}`, jessUser)).toBe(0);
    // Staff may still lock staff members (booking does) and leave the business themselves.
    const locked = await as(
      jessUser,
      async (tx) => (await tx.execute(sql`SELECT id FROM staff_members FOR UPDATE`)).rows.length,
    );
    expect(locked).toBe(2);
    const leave = await as(ben, async (tx) => {
      const { rowCount } = await tx.execute(sql`DELETE FROM memberships WHERE user_id = ${ben}`);
      throw Object.assign(new Error('roll back'), { rowCount });
    }).catch((e: unknown) => (e as { rowCount: number }).rowCount);
    expect(leave).toBe(1);
    // Owners and managers still change both.
    await as(cara, (tx) =>
      tx.execute(sql`UPDATE staff_members SET active = active WHERE id = ${b.marco}`),
    );
    await as(ana, (tx) =>
      tx.execute(sql`UPDATE memberships SET role = 'staff' WHERE user_id = ${ben}`),
    );
  });

  it('owners, managers and work without a user see every booking', async () => {
    const all = [jessBooking, marcoBooking].sort();
    expect(await rows(ana, 'bookings')).toEqual(all);
    expect(await rows(cara, 'bookings')).toEqual(all);
    const { rows: seen } = await withTenant(db, b.tenant, (tx) =>
      tx.execute<{ id: string }>(sql`SELECT id::text FROM bookings ORDER BY id`),
    );
    expect(seen.map((r) => r.id)).toEqual(all);
  });

  it("a staff member sees only their own staff member's bookings and waitlist entries", async () => {
    expect(await rows(jessUser, 'bookings')).toEqual([jessBooking]);
    // An entry for anyone is not hers: owners and managers hand those out.
    expect(await rows(jessUser, 'waitlist_entries')).toEqual([jessWaitlist]);
    expect(await rows(ana, 'waitlist_entries')).toEqual([jessWaitlist, anyoneWaitlist].sort());
  });

  it('staff without a staff member, and users who are not members, see none', async () => {
    for (const user of [ben, stranger]) {
      expect(await rows(user, 'bookings')).toEqual([]);
      expect(await rows(user, 'waitlist_entries')).toEqual([]);
      expect(await rows(user, 'clients')).toEqual([]);
    }
  });

  it("everyone sees the team's busy times, without booking details", async () => {
    for (const user of [jessUser, ben]) {
      expect(await rows(user, 'booking_occupancy')).toEqual([jessBooking, marcoBooking].sort());
    }
  });

  it("staff see only their own bookings' and waitlist entries' clients", async () => {
    // Maria is Jess's booking's client; Lee is Marco's (and on the waitlist for Jess).
    expect(await rows(jessUser, 'clients')).toEqual([b.client, marcosClient].sort());
    await as(jessUser, (tx) => cancelWaitlistEntry(tx, WaitlistEntryIdSchema.parse(jessWaitlist)));
    expect(await rows(jessUser, 'clients')).toEqual([b.client, marcosClient].sort());
    // The entry stays hers while cancelled; once it is moved to anyone, Lee is not hers.
    await withTenant(db, b.tenant, (tx) =>
      tx.execute(
        sql`UPDATE waitlist_entries SET staff_member_id = NULL WHERE id = ${jessWaitlist}`,
      ),
    );
    expect(await rows(jessUser, 'clients')).toEqual([b.client]);
  });

  it("staff cannot change another staff member's booking", async () => {
    const updated = await as(jessUser, (tx) =>
      tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${marcoBooking}`),
    );
    const deleted = await as(jessUser, (tx) =>
      tx.execute(sql`DELETE FROM bookings WHERE id = ${marcoBooking}`),
    );
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    expect(await withTenant(db, b.tenant, (tx) => findBooking(tx, marcoBooking))).toMatchObject({
      status: 'confirmed',
    });
  });

  it('staff cannot book for, or move a booking to, another staff member (42501)', async () => {
    const insert = await as(jessUser, (tx) =>
      insertBooking(tx, booking(b, b.marco, '2026-11-10T14:00:00Z')),
    ).catch((e: unknown) => e);
    expect(sqlState(insert)).toBe('42501');
    const move = await as(jessUser, (tx) =>
      moveBooking(tx, jessBooking, {
        staffMemberId: b.marco,
        startsAt: at('2026-11-10T14:00:00Z'),
        endsAt: at('2026-11-10T15:00:00Z'),
        overridden: false,
      }),
    ).catch((e: unknown) => e);
    expect(sqlState(move)).toBe('42501');
  });

  it('staff can book and move their own bookings', async () => {
    const own = await as(jessUser, (tx) =>
      insertBooking(tx, booking(b, b.jess, '2026-11-11T14:00:00Z')),
    );
    const moved = await as(jessUser, (tx) =>
      moveBooking(tx, BookingIdSchema.parse(own.id), {
        staffMemberId: b.jess,
        startsAt: at('2026-11-11T16:00:00Z'),
        endsAt: at('2026-11-11T17:00:00Z'),
        overridden: false,
      }),
    );
    expect(moved?.startsAt).toEqual(at('2026-11-11T16:00:00Z'));
  });

  it("staff cannot write another staff member's busy time directly", async () => {
    const insert = await as(jessUser, (tx) =>
      tx.execute(sql`INSERT INTO booking_occupancy (id, staff_member_id, starts_at, ends_at, occupied)
        VALUES (${newId()}, ${b.marco}, '2026-11-12T14:00Z', '2026-11-12T15:00Z',
                tstzrange('2026-11-12T14:00Z', '2026-11-12T15:00Z'))`),
    ).catch((e: unknown) => e);
    expect(sqlState(insert)).toBe('42501');
    const deleted = await as(jessUser, (tx) =>
      tx.execute(sql`DELETE FROM booking_occupancy WHERE id = ${marcoBooking}`),
    );
    expect(deleted.rowCount).toBe(0);
  });

  it('staff cannot add, change or delete clients, even their own', async () => {
    const insert = await as(jessUser, (tx) =>
      insertClient(tx, { name: 'Walk-in', email: null, phone: null, source: 'team' }),
    ).catch((e: unknown) => e);
    expect(sqlState(insert)).toBe('42501');
    const update = await as(jessUser, (tx) =>
      tx.execute(sql`UPDATE clients SET name = 'Changed' WHERE id = ${b.client}`),
    ).catch((e: unknown) => e);
    expect(sqlState(update)).toBe('42501');
    const deleted = await as(jessUser, (tx) =>
      tx.execute(sql`DELETE FROM clients WHERE id = ${b.client}`),
    );
    expect(deleted.rowCount).toBe(0);
    expect(await withTenant(db, b.tenant, (tx) => findClient(tx, b.client))).toMatchObject({
      name: 'Maria Lopez',
    });
  });

  it('ADR-0020: an exact email or phone shows staff those clients, read-only, for that transaction', async () => {
    const add = (name: string, email: string | null, phone: string | null) =>
      withTenant(db, b.tenant, async (tx) =>
        ClientIdSchema.parse((await insertClient(tx, { name, email, phone, source: 'team' })).id),
      );
    const dee = await add('Dee', 'dee@example.test', '+15550001111');
    const dan = await add('Dan', null, '+15550001111');
    const other = await add('Olive', 'olive@example.test', '+15550002222');
    const lookUp = (userId: UserId, contact: string) =>
      as(userId, async (tx) => {
        const parsed = ClientContactSchema.parse(contact);
        await setTransactionClientContact(tx, parsed);
        const found = (await findClientsByContact(tx, parsed)).map((c) => c.id);
        const visible = await tx.execute<{ id: string }>(
          sql`SELECT id::text FROM clients ORDER BY id`,
        );
        return { found, visible: visible.rows.map((r) => r.id) };
      });

    // A phone shared by two clients finds both (by name); the email finds one.
    const own = await rows(jessUser, 'clients');
    const byPhone = await lookUp(jessUser, '+15550001111');
    expect(byPhone.found).toEqual([dan, dee]);
    expect(byPhone.visible).toEqual([...own, dee, dan].sort());
    expect((await lookUp(jessUser, 'DEE@example.test')).found).toEqual([dee]);
    // Staff without a staff member get the match too, and nothing else.
    expect(await lookUp(ben, 'olive@example.test')).toEqual({ found: [other], visible: [other] });
    // Another business's member finds nothing.
    const elsewhere = await newBusiness();
    const outsider = await insertUser(db, 'Outsider');
    await withTenant(db, elsewhere.tenant, (tx) =>
      addMembership(tx, { userId: outsider, role: 'staff' }),
    );
    const outside = await withMember(db, { tenantId: elsewhere.tenant, userId: outsider }, (tx) =>
      setTransactionClientContact(tx, ClientContactSchema.parse('dee@example.test')).then(() =>
        findClientsByContact(tx, ClientContactSchema.parse('dee@example.test')),
      ),
    );
    expect(outside).toEqual([]);

    // The match is read-only, and gone once the setting is cleared or the transaction ends.
    const write = await as(jessUser, async (tx) => {
      await setTransactionClientContact(tx, ClientContactSchema.parse('dee@example.test'));
      return tx.execute(sql`UPDATE clients SET name = 'Changed' WHERE id = ${dee}`);
    }).catch((e: unknown) => e);
    expect(sqlState(write)).toBe('42501');
    const deleted = await as(jessUser, async (tx) => {
      await setTransactionClientContact(tx, ClientContactSchema.parse('dee@example.test'));
      return (await tx.execute(sql`DELETE FROM clients WHERE id = ${dee}`)).rowCount;
    });
    expect(deleted).toBe(0);
    const cleared = await as(jessUser, async (tx) => {
      await setTransactionClientContact(tx, ClientContactSchema.parse('dee@example.test'));
      await setTransactionClientContact(tx, null);
      return findClientsByContact(tx, ClientContactSchema.parse('dee@example.test'));
    });
    expect(cleared).toEqual([]);
    expect(await rows(jessUser, 'clients')).toEqual(own);
  });

  it('a removed member loses their scope at once', async () => {
    const removed = await insertUser(db, 'Removed');
    await withTenant(db, b.tenant, (tx) => addMembership(tx, { userId: removed, role: 'owner' }));
    expect(await rows(removed, 'bookings')).toEqual(await rows(ana, 'bookings'));
    await withTenant(db, b.tenant, (tx) => deleteMembership(tx, removed));
    expect(await rows(removed, 'bookings')).toEqual([]);
  });
});
