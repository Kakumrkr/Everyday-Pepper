// Google Calendar out's records (S71, ADR-0069 §10, AC-X-168…171, AC-X-174): the trigger on
// bookings queues every write of a booking whose staff member's calendar takes bookings, and
// follows a queued booking wherever it goes; a row is claimed by one writer at a time; a change
// made during a write keeps it due; the scan sees ids only. Part of the isolation evidence with
// isolation.int.test.ts.
import {
  BookingIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking, moveBooking, setBookingStatus } from './repositories/bookings.js';
import {
  claimCalendarEventSync,
  clearBookingsCalendar,
  eventsReadCursorOf,
  findCalendarEventSyncsOfBookings,
  isSettled,
  leaseEventSyncForStray,
  releaseEventSyncLease,
  requeueSettledEventSync,
  storeEventsReadCursor,
  findBookingEventSource,
  findCalendarEventSyncOfBooking,
  listDueCalendarEventSyncs,
  queueUpcomingBookingSyncs,
  recordCalendarEventFailure,
  recordCalendarEventWritten,
  storeBookingsCalendar,
  wakeCalendarEventSyncs,
} from './repositories/calendar-events.js';
import { findCalendarConnection, saveCalendarConnection } from './repositories/calendar-sync.js';
import { deleteClientRow, insertClient } from './repositories/clients.js';
import { listOpenFeedItems, writeCalendarKeptNote } from './repositories/feed.js';
import { addMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;

const NOW = new Date('2026-12-01T12:00:00Z');
const LEASE = 120_000;

async function business(): Promise<TenantId> {
  const slug = `cal-out-${randomBytes(5).toString('hex')}`;
  return TenantIdSchema.parse(
    (await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' })).id,
  );
}

async function staffWith(tx: TenantTx, writesBookings: boolean | null) {
  const userId = await insertUser(db);
  const membership = await addMembership(tx, { userId, role: 'staff' });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jo',
    color: '#2a7230',
    active: true,
    membershipId: membership.id,
  });
  const staffMemberId = StaffMemberIdSchema.parse(staff.id);
  if (writesBookings === null) return { staffMemberId, connection: undefined, userId };
  const connection = await saveCalendarConnection(
    tx,
    {
      id: newId(),
      staffMemberId,
      membershipId: membership.id,
      provider: 'sandbox',
      accountEmail: 'jo@example.com',
      refreshTokenSealed: randomBytes(60),
      accessTokenSealed: randomBytes(60),
      accessTokenExpiresAt: new Date('2026-12-01T13:00:00Z'),
      createdBy: userId,
      connectedAt: NOW,
      writesBookings,
    },
    false,
  );
  return { staffMemberId, connection, userId, membershipId: membership.id };
}

async function book(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  startsAt: string,
  serviceName = `Service ${newId()}`,
) {
  const client = await insertClient(tx, {
    name: 'Ana María Lopez',
    email: `ana-${newId()}@example.test`,
    phone: '+15555550100',
    source: 'team',
  });
  const service = await insertService(tx, {
    name: serviceName,
    category: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    active: true,
  });
  const start = new Date(startsAt);
  return insertBooking(tx, {
    clientId: ClientIdSchema.parse(client.id),
    serviceId: ServiceIdSchema.parse(service.id),
    staffMemberId,
    startsAt: start,
    endsAt: new Date(start.getTime() + 45 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
}

async function versionOf(tx: TenantTx, bookingId: string) {
  return (await findCalendarEventSyncOfBooking(tx, bookingId))?.version;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('the trigger on bookings (AC-X-168)', () => {
  it('queues nothing for a staff member without a calendar that takes bookings', async () => {
    await withTenant(db, await business(), async (tx) => {
      const none = await staffWith(tx, null);
      const busyOnly = await staffWith(tx, false);
      const a = await book(tx, none.staffMemberId, '2026-12-02T15:00:00Z');
      const b = await book(tx, busyOnly.staffMemberId, '2026-12-02T15:00:00Z');
      expect(await findCalendarEventSyncOfBooking(tx, a.id)).toBeUndefined();
      expect(await findCalendarEventSyncOfBooking(tx, b.id)).toBeUndefined();
    });
  });

  it('raises the version on each change the event shows, and follows the booking anywhere', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const sam = await staffWith(tx, null);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      const id = BookingIdSchema.parse(row.id);
      expect(await findCalendarEventSyncOfBooking(tx, id)).toMatchObject({
        version: 1,
        syncedVersion: null,
        dueAt: null,
        eventConnectionId: null,
      });
      await moveBooking(tx, id, {
        staffMemberId: jo.staffMemberId,
        startsAt: new Date('2026-12-02T16:00:00Z'),
        endsAt: new Date('2026-12-02T16:45:00Z'),
        overridden: false,
      });
      expect(await versionOf(tx, id)).toBe(2);
      // A change the event doesn't show (the client confirming by text) writes nothing.
      await tx.execute(sql`UPDATE bookings SET client_confirmed_at = now() WHERE id = ${id}`);
      expect(await versionOf(tx, id)).toBe(2);
      // To a staff member without a calendar: still followed, so the event can be removed.
      await tx.execute(
        sql`UPDATE bookings SET staff_member_id = ${sam.staffMemberId} WHERE id = ${id}`,
      );
      expect(await versionOf(tx, id)).toBe(3);
      await setBookingStatus(tx, id, 'cancelled', new Date());
      expect(await versionOf(tx, id)).toBe(4);
      // Removed (an undone import): the row stays, so its event is removed.
      await tx.execute(sql`DELETE FROM bookings WHERE id = ${id}`);
      expect(await versionOf(tx, id)).toBe(5);
    });
  });

  it('makes a waiting or failed row due again on a change', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      const claimed = await claimCalendarEventSync(tx, row.id, NOW, LEASE);
      if (claimed === undefined) throw new Error('not claimed');
      await recordCalendarEventFailure(
        tx,
        claimed,
        'unavailable',
        new Date('2026-12-01T13:00:00Z'),
      );
      expect(await listDue(tx, NOW)).not.toContain(row.id);
      await tx.execute(sql`UPDATE bookings SET status = 'completed' WHERE id = ${row.id}`);
      expect(await findCalendarEventSyncOfBooking(tx, row.id)).toMatchObject({
        dueAt: null,
        attempts: 0,
        lastError: null,
      });
    });
  });
});

/** The due bookings of the transaction's business, through the job's scan. */
async function listDue(tx: TenantTx, now: Date): Promise<string[]> {
  const [tenant] = (await tx.execute(sql`SELECT current_tenant_id() AS id`)).rows as {
    id: string;
  }[];
  return (await listDueCalendarEventSyncs(db, now, 1000))
    .filter((due) => due.tenantId === tenant?.id)
    .map((due) => due.bookingId);
}

describe('claiming and writing (AC-X-169, AC-X-170)', () => {
  it('lets one writer at a time hold a booking, and keeps a change made meanwhile due', async () => {
    const tenant = await business();
    const { bookingId, connectionId } = await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      return { bookingId: row.id, connectionId: jo.connection?.id ?? '' };
    });
    const due = await listDueCalendarEventSyncs(db, NOW, 1000);
    expect(due).toContainEqual({ tenantId: tenant, bookingId });

    const first = await withTenant(db, tenant, (tx) =>
      claimCalendarEventSync(tx, bookingId, NOW, LEASE),
    );
    const second = await withTenant(db, tenant, (tx) =>
      claimCalendarEventSync(tx, bookingId, NOW, LEASE),
    );
    expect(first?.version).toBe(1);
    expect(second).toBeUndefined();
    // A change while the first writes it.
    await withTenant(db, tenant, (tx) =>
      tx.execute(sql`UPDATE bookings SET starts_at = starts_at + interval '1 hour',
        ends_at = ends_at + interval '1 hour' WHERE id = ${bookingId}`),
    );
    await withTenant(db, tenant, async (tx) => {
      if (first === undefined) throw new Error('not claimed');
      await recordCalendarEventWritten(tx, first, { connectionId, calendarId: 'cal-1' });
      expect(await findCalendarEventSyncOfBooking(tx, bookingId)).toMatchObject({
        version: 2,
        syncedVersion: 1,
        eventConnectionId: connectionId,
        eventCalendarId: 'cal-1',
        leasedUntil: null,
      });
      // Still due for version 2; once written, not.
      const again = await claimCalendarEventSync(tx, bookingId, NOW, LEASE);
      expect(again?.version).toBe(2);
      if (again === undefined) throw new Error('not claimed');
      await recordCalendarEventWritten(tx, again, { connectionId, calendarId: 'cal-1' });
      expect(await claimCalendarEventSync(tx, bookingId, NOW, LEASE)).toBeUndefined();
    });
    expect(await listDueCalendarEventSyncs(db, NOW, 1000)).not.toContainEqual({
      tenantId: tenant,
      bookingId,
    });
  });

  it('lets a lapsed lease be claimed again, and waits for a retry time', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      expect(await claimCalendarEventSync(tx, row.id, NOW, LEASE)).toBeDefined();
      const later = new Date(NOW.getTime() + LEASE);
      const reclaimed = await claimCalendarEventSync(tx, row.id, later, LEASE);
      if (reclaimed === undefined) throw new Error('not reclaimed');
      const retryAt = new Date(later.getTime() + 60_000);
      await recordCalendarEventFailure(tx, reclaimed, 'rate_limited', retryAt);
      expect(await claimCalendarEventSync(tx, row.id, later, LEASE)).toBeUndefined();
      expect((await findCalendarEventSyncOfBooking(tx, row.id))?.attempts).toBe(1);
      expect(await claimCalendarEventSync(tx, row.id, retryAt, LEASE)).toBeDefined();
    });
  });

  it('wakes every waiting write at a reconnect', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      const claimed = await claimCalendarEventSync(tx, row.id, NOW, LEASE);
      if (claimed === undefined) throw new Error('not claimed');
      await recordCalendarEventFailure(
        tx,
        claimed,
        'invalid_grant',
        new Date('2026-12-01T13:00:00Z'),
      );
      await wakeCalendarEventSyncs(tx);
      expect(await claimCalendarEventSync(tx, row.id, NOW, LEASE)).toBeDefined();
    });
  });
});

describe('the grant and the bookings calendar (AC-X-170, AC-X-171)', () => {
  it("queues the staff member's bookings of the window that aren't cancelled", async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, false);
      const other = await staffWith(tx, false);
      const soon = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      const past = await book(tx, jo.staffMemberId, '2026-11-30T15:00:00Z');
      const far = await book(tx, jo.staffMemberId, '2027-03-02T15:00:00Z');
      const cancelled = await book(tx, jo.staffMemberId, '2026-12-03T15:00:00Z');
      await tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${cancelled.id}`);
      const colleague = await book(tx, other.staffMemberId, '2026-12-02T15:00:00Z');
      const range = { from: NOW, to: new Date('2027-01-30T12:00:00Z') };
      expect(await queueUpcomingBookingSyncs(tx, jo.staffMemberId, range)).toBe(1);
      expect(await versionOf(tx, soon.id)).toBe(1);
      for (const id of [past.id, far.id, cancelled.id, colleague.id]) {
        expect(await findCalendarEventSyncOfBooking(tx, id)).toBeUndefined();
      }
      // Again (a reconnect): the version rises, no second row.
      expect(await queueUpcomingBookingSyncs(tx, jo.staffMemberId, range)).toBe(1);
      expect(await versionOf(tx, soon.id)).toBe(2);
    });
  });

  it('keeps the first calendar stored, and none for an old grant', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const connection = jo.connection;
      if (connection === undefined) throw new Error('no connection');
      expect(await storeBookingsCalendar(tx, connection, 'cal-a')).toBe('cal-a');
      expect(await storeBookingsCalendar(tx, connection, 'cal-b')).toBe('cal-a');
      await tx.execute(sql`UPDATE calendar_connections SET bookings_calendar_id = NULL,
        generation = generation + 1 WHERE id = ${connection.id}`);
      expect(await storeBookingsCalendar(tx, connection, 'cal-c')).toBeNull();
    });
  });

  it('forgets a deleted calendar and queues its events again', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const connectionId = jo.connection?.id ?? '';
      await tx.execute(
        sql`UPDATE calendar_connections SET bookings_calendar_id = 'cal-a' WHERE id = ${connectionId}`,
      );
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z');
      const claimed = await claimCalendarEventSync(tx, row.id, NOW, LEASE);
      if (claimed === undefined) throw new Error('not claimed');
      await recordCalendarEventWritten(tx, claimed, { connectionId, calendarId: 'cal-a' });
      await clearBookingsCalendar(tx, connectionId, 'cal-a');
      expect((await findCalendarConnection(tx, connectionId))?.bookingsCalendarId).toBeNull();
      expect(await findCalendarEventSyncOfBooking(tx, row.id)).toMatchObject({
        version: 2,
        syncedVersion: 1,
        eventConnectionId: null,
        eventCalendarId: null,
      });
    });
  });

  it('forgets the calendar when another Google account reconnects', async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const connection = jo.connection;
      if (connection === undefined) throw new Error('no connection');
      await storeBookingsCalendar(tx, connection, 'cal-a');
      const again = (accountEmail: string) =>
        saveCalendarConnection(
          tx,
          {
            id: connection.id,
            staffMemberId: jo.staffMemberId,
            membershipId: connection.membershipId,
            provider: 'sandbox',
            accountEmail,
            refreshTokenSealed: randomBytes(60),
            accessTokenSealed: randomBytes(60),
            accessTokenExpiresAt: new Date('2026-12-01T13:00:00Z'),
            createdBy: jo.userId,
            connectedAt: NOW,
            writesBookings: true,
          },
          true,
        );
      expect((await again('jo@example.com')).bookingsCalendarId).toBe('cal-a');
      expect((await again('other@example.com')).bookingsCalendarId).toBeNull();
    });
  });

  it("reads what the event shows: the service and the client's name, no contact details", async () => {
    await withTenant(db, await business(), async (tx) => {
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-12-02T15:00:00Z', 'Skin fade');
      const source = await findBookingEventSource(tx, row.id);
      expect(source).toEqual({
        id: row.id,
        staffMemberId: jo.staffMemberId,
        serviceId: row.serviceId,
        clientId: row.clientId,
        status: 'confirmed',
        startsAt: new Date('2026-12-02T15:00:00Z'),
        endsAt: new Date('2026-12-02T15:45:00Z'),
        serviceName: 'Skin fade',
        clientName: 'Ana María Lopez',
        clientDeleted: false,
      });
      expect(await findBookingEventSource(tx, newId())).toBeUndefined();
    });
  });
});

describe('a deleted client (ADR-0051)', () => {
  it("queues their visits' events again, to be written without their name", async () => {
    const tenantId = await business();
    const ownerId = await insertUser(db);
    const { bookingId, clientId } = await withTenant(db, tenantId, async (tx) => {
      await addMembership(tx, { userId: ownerId, role: 'owner' });
      const jo = await staffWith(tx, true);
      const row = await book(tx, jo.staffMemberId, '2026-11-20T15:00:00Z');
      const claimed = await claimCalendarEventSync(tx, row.id, NOW, LEASE);
      if (claimed === undefined) throw new Error('not claimed');
      await recordCalendarEventWritten(tx, claimed, {
        connectionId: jo.connection?.id ?? '',
        calendarId: 'cal-a',
      });
      return { bookingId: row.id, clientId: ClientIdSchema.parse(row.clientId) };
    });
    // Only owners and managers delete clients.
    await withMember(db, { tenantId, userId: ownerId }, async (tx) => {
      expect(await deleteClientRow(tx, clientId, NOW)).toMatchObject({ deleted: true });
      expect(await findCalendarEventSyncOfBooking(tx, bookingId)).toMatchObject({
        version: 2,
        syncedVersion: 1,
      });
      expect(await findBookingEventSource(tx, bookingId)).toMatchObject({ clientDeleted: true });
    });
  });
});

describe('the rows carry no client data (AC-X-174)', () => {
  it('holds ids, versions and times only', async () => {
    const columns = await db.execute(sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'calendar_event_syncs' ORDER BY column_name`);
    expect((columns.rows as { column_name: string }[]).map((c) => c.column_name)).toEqual([
      'attempts',
      'booking_id',
      'created_at',
      'due_at',
      'event_calendar_id',
      'event_connection_id',
      'id',
      'kept_at',
      'last_error',
      'leased_until',
      'synced_version',
      'tenant_id',
      'updated_at',
      'version',
    ]);
  });
});

/** Writes a booking's row at its version into `calendarId`, as the worker would. */
async function written(tx: TenantTx, bookingId: string, connectionId: string, calendarId: string) {
  const claimed = await claimCalendarEventSync(tx, bookingId, NOW, LEASE);
  if (claimed === undefined) throw new Error('not claimed');
  await recordCalendarEventWritten(tx, claimed, { connectionId, calendarId });
  const row = await findCalendarEventSyncOfBooking(tx, bookingId);
  if (row === undefined) throw new Error('no row');
  return row;
}

describe('renames rewrite events (S71.2, AC-X-178)', () => {
  it("raises the versions of a renamed service's and client's bookings that haven't ended", async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const connectionId = jo.connection?.id ?? '';
      const soon = await book(tx, jo.staffMemberId, '2099-03-02T15:00:00Z');
      const past = await book(tx, jo.staffMemberId, '2020-03-02T15:00:00Z');
      // The past booking shares the upcoming one's service and client.
      await tx.execute(sql`UPDATE bookings SET service_id = ${soon.serviceId},
        client_id = ${soon.clientId} WHERE id = ${past.id}`);
      const before = {
        soon: (await written(tx, soon.id, connectionId, 'cal-1')).version,
        past: (await written(tx, past.id, connectionId, 'cal-1')).version,
      };

      await tx.execute(sql`UPDATE services SET name = 'Skin fade' WHERE id = ${soon.serviceId}`);
      expect(await versionOf(tx, soon.id)).toBe(before.soon + 1);
      expect(await versionOf(tx, past.id)).toBe(before.past);

      await tx.execute(sql`UPDATE clients SET name = 'Ana Ruiz' WHERE id = ${soon.clientId}`);
      expect(await versionOf(tx, soon.id)).toBe(before.soon + 2);
      expect(await versionOf(tx, past.id)).toBe(before.past);

      // Anything else about them changes nothing.
      await tx.execute(sql`UPDATE services SET duration_minutes = 50 WHERE id = ${soon.serviceId}`);
      await tx.execute(sql`UPDATE clients SET name = 'Ana Ruiz', phone = '+15555550199'
        WHERE id = ${soon.clientId}`);
      expect(await versionOf(tx, soon.id)).toBe(before.soon + 2);
      expect((await findCalendarEventSyncOfBooking(tx, soon.id))?.dueAt).toBeNull();
    });
  });
});

describe('the read-back cursor (S71.2, AC-X-175)', () => {
  it('keeps the tokens for the generation and calendar they were read with only', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const connection = jo.connection;
      if (connection === undefined) throw new Error('no connection');
      expect(await storeBookingsCalendar(tx, connection, 'cal-1')).toBe('cal-1');
      // Nothing read yet: the whole calendar.
      const fresh = await findCalendarConnection(tx, connection.id);
      if (fresh === undefined) throw new Error('gone');
      expect(eventsReadCursorOf(fresh, 'cal-1')).toEqual({ syncToken: null, pageToken: null });

      const readAt = new Date('2026-12-01T12:05:00Z');
      expect(
        await storeEventsReadCursor(
          tx,
          fresh,
          'cal-1',
          { syncToken: 'sync-1', pageToken: null },
          readAt,
        ),
      ).toBe(true);
      const read = await findCalendarConnection(tx, connection.id);
      if (read === undefined) throw new Error('gone');
      expect(eventsReadCursorOf(read, 'cal-1')).toEqual({ syncToken: 'sync-1', pageToken: null });
      expect(read.eventsReadAt).toEqual(readAt);
      // Another calendar (made again) starts over.
      expect(eventsReadCursorOf(read, 'cal-2')).toEqual({ syncToken: null, pageToken: null });
      // A read under an old generation, or of a calendar the connection no longer has, keeps nothing.
      expect(
        await storeEventsReadCursor(
          tx,
          { id: connection.id, generation: connection.generation + 1 },
          'cal-1',
          { syncToken: 'sync-old', pageToken: null },
          null,
        ),
      ).toBe(false);
      expect(
        await storeEventsReadCursor(tx, read, 'cal-2', { syncToken: 'x', pageToken: null }, null),
      ).toBe(false);
      // A reconnect (a new generation) starts over.
      await tx.execute(sql`UPDATE calendar_connections SET generation = generation + 1
        WHERE id = ${connection.id}`);
      const reconnected = await findCalendarConnection(tx, connection.id);
      if (reconnected === undefined) throw new Error('gone');
      expect(eventsReadCursorOf(reconnected, 'cal-1')).toEqual({
        syncToken: null,
        pageToken: null,
      });
    });
  });
});

describe('putting Pepper back (S71.2, AC-X-176, AC-X-177)', () => {
  it('queues a settled booking again only at the version read, and marks it kept', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const booking = await book(tx, jo.staffMemberId, '2099-03-02T15:00:00Z');
      const row = await written(tx, booking.id, jo.connection?.id ?? '', 'cal-1');
      expect(isSettled(row, NOW)).toBe(true);
      expect(row.keptAt).toBeNull();

      expect(await requeueSettledEventSync(tx, row, NOW, true)).toBe(true);
      const queued = await findCalendarEventSyncOfBooking(tx, booking.id);
      expect(queued).toMatchObject({ version: row.version + 1, keptAt: NOW });
      if (queued === undefined) throw new Error('gone');
      expect(isSettled(queued, NOW)).toBe(false);
      // A second read of the same change finds it queued already: nothing more.
      expect(await requeueSettledEventSync(tx, row, NOW, true)).toBe(false);
      // A row being written isn't touched either.
      const claimed = await claimCalendarEventSync(tx, booking.id, NOW, LEASE);
      if (claimed === undefined) throw new Error('not claimed');
      expect(await requeueSettledEventSync(tx, claimed, NOW, false)).toBe(false);
    });
  });

  it('holds a row while a stray copy is removed, never over a writer', async () => {
    const tenant = await business();
    await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const booking = await book(tx, jo.staffMemberId, '2099-03-02T15:00:00Z');
      const row = await written(tx, booking.id, jo.connection?.id ?? '', 'cal-1');
      const rows = await findCalendarEventSyncsOfBookings(tx, [booking.id, newId()]);
      expect([...rows.keys()]).toEqual([booking.id]);

      const held = await leaseEventSyncForStray(tx, row.id, NOW, LEASE);
      expect(held?.leasedUntil).toEqual(new Date(NOW.getTime() + LEASE));
      expect(await leaseEventSyncForStray(tx, row.id, NOW, LEASE)).toBeUndefined();
      // A change meanwhile can't be claimed by a writer until the lease is given back.
      await setBookingStatus(tx, BookingIdSchema.parse(booking.id), 'cancelled', new Date());
      expect(await claimCalendarEventSync(tx, booking.id, NOW, LEASE)).toBeUndefined();
      if (held === undefined) throw new Error('not held');
      await releaseEventSyncLease(tx, held);
      expect((await claimCalendarEventSync(tx, booking.id, NOW, LEASE))?.version).toBe(
        row.version + 1,
      );
    });
  });

  it('writes one note per booking, to its staff member and owners, never a colleague', async () => {
    const tenant = await business();
    const { jo, ben, booking } = await withTenant(db, tenant, async (tx) => {
      const jo = await staffWith(tx, true);
      const ben = await staffWith(tx, null);
      const booking = await book(tx, jo.staffMemberId, '2099-03-02T15:00:00Z');
      const note = {
        bookingId: booking.id,
        staffMemberId: jo.staffMemberId,
        clientId: booking.clientId,
        serviceId: booking.serviceId,
        day: '2099-03-02',
        payload: {
          change: 'moved' as const,
          startsAt: UtcDateTimeSchema.parse('2099-03-02T15:00:00.000Z'),
        },
        expiresAt: new Date('2099-03-05T00:00:00Z'),
      };
      await writeCalendarKeptNote(tx, note);
      await writeCalendarKeptNote(tx, { ...note, payload: { ...note.payload, change: 'deleted' } });
      return { jo, ben, booking };
    });
    const seen = async (userId: string) =>
      withMember(db, { tenantId: tenant, userId: UserIdSchema.parse(userId) }, (tx) =>
        listOpenFeedItems(tx, NOW),
      );
    const own = await seen(jo.userId);
    expect(own.filter((item) => item.kind === 'calendar_kept')).toMatchObject([
      { bookingId: booking.id, payload: { change: 'deleted' } },
    ]);
    const colleague = await seen(ben.userId);
    expect(colleague.filter((item) => item.kind === 'calendar_kept')).toEqual([]);
  });
});
