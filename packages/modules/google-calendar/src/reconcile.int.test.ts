// Google Calendar reconciliation (S71.2, ADR-0069 §11; AC-X-175…180): "Pepper bookings" read back
// with sync tokens, a change made in Google put back with a note, stray events removed, renames
// rewritten, a deleted calendar made again — against real Postgres with the sandbox, which keeps
// calendars, events and change numbers as Google does.
import {
  BookingIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  calendarEventIdOf,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, ManualClock, outboxKeyFrom, type Actor } from '@pepper/core';
import {
  addMembership,
  findCalendarConnectionOfStaff,
  findCalendarEventSyncOfBooking,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listOpenFeedItems,
  newId,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBookingCalendarState, writeBookingEvent } from './events.js';
import { insertUser, startTestDatabase, type TestDatabase } from './int-support.js';
import { CalendarProviderError, type ListEventsInput } from './provider.js';
import { reconcileBookingsCalendar } from './reconcile.js';
import { SandboxCalendarProvider } from './sandbox.js';
import {
  completeCalendarConnect,
  readCalendar,
  startCalendarConnect,
  type CalendarDeps,
} from './services.js';
import { calendarTokenKeyFrom } from './tokens.js';

const REDIRECT = 'https://app.example/more/calendar/google';
const START = new Date('2026-12-01T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

let database: TestDatabase;
let db: Database;
let slugs = 0;

/** The sandbox, with every `listEvents` call kept and the next ones' failures scripted. */
class Watched extends SandboxCalendarProvider {
  lists: ListEventsInput[] = [];
  deletedEvents: string[] = [];
  /** Runs during the next stray delete, as if a write were trying to claim the row meanwhile. */
  duringDelete: (() => Promise<void>) | null = null;
  /** Runs after the next page is read and before it is answered (a write racing the read). */
  afterList: (() => Promise<void>) | null = null;
  /** The next deletes fail with this. */
  deleteFails: CalendarProviderError[] = [];

  override async listEvents(input: ListEventsInput) {
    this.lists.push(input);
    const page = await super.listEvents(input);
    const after = this.afterList;
    this.afterList = null;
    if (after !== null) await after();
    return page;
  }

  override async deleteEvent(input: Parameters<SandboxCalendarProvider['deleteEvent']>[0]) {
    this.deletedEvents.push(input.eventId);
    const failure = this.deleteFails.shift();
    if (failure !== undefined) throw failure;
    const during = this.duringDelete;
    this.duringDelete = null;
    if (during !== null) await during();
    return super.deleteEvent(input);
  }
}

interface Business {
  tenantId: TenantId;
  clock: ManualClock;
  provider: Watched;
  deps: CalendarDeps;
}

async function aBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `grec-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const clock = new ManualClock(START);
  const provider = new Watched(REDIRECT, () => clock.now().getTime());
  return {
    tenantId: TenantIdSchema.parse(tenant.id),
    clock,
    provider,
    deps: { db, provider, tokenKey: calendarTokenKeyFrom(outboxKeyFrom('z'.repeat(40))), clock },
  };
}

async function aStaffMember(b: Business, name: string) {
  const userId = await insertUser(db, name);
  const staffMemberId = await withTenant(db, b.tenantId, async (tx) => {
    const membership = await addMembership(tx, { userId, role: 'staff' });
    const staff = await insertStaffMember(tx, {
      displayName: name,
      color: '#2a7230',
      active: true,
      membershipId: membership.id,
    });
    return StaffMemberIdSchema.parse(staff.id);
  });
  const actor: Actor = { context: { tenantId: b.tenantId, userId, role: 'staff' } };
  return { staffMemberId, actor };
}

async function connect(b: Business, actor: Actor) {
  const { url } = await startCalendarConnect(b.deps, actor);
  const state = new URL(url).searchParams.get('state') ?? '';
  return completeCalendarConnect(b.deps, actor, { code: 'sandbox-ok', state });
}

async function book(
  b: Business,
  staffMemberId: StaffMemberId,
  startsAt: string,
  serviceName = 'Skin fade',
) {
  return withTenant(db, b.tenantId, async (tx) => {
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
    const row = await insertBooking(tx, {
      clientId: ClientIdSchema.parse(client.id),
      serviceId: ServiceIdSchema.parse(service.id),
      staffMemberId,
      startsAt: start,
      endsAt: new Date(start.getTime() + 45 * MINUTE),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: null,
      priceToCents: null,
      source: 'team',
      overridden: false,
      idempotencyKey: null,
      createdBy: null,
    });
    return {
      bookingId: BookingIdSchema.parse(row.id),
      serviceId: service.id,
      clientId: client.id,
    };
  });
}

/** A statement in the business's transaction; only parsed UUIDs are put into it. */
const run = (b: Business, statement: (uuid: (id: string) => string) => string) =>
  withTenant(db, b.tenantId, (tx) => tx.execute(statement((id) => `'${z(id)}'`)));
const z = (id: string) => BookingIdSchema.parse(id);

const write = (b: Business, bookingId: string) => writeBookingEvent(b.deps, b.tenantId, bookingId);
const syncOf = (b: Business, bookingId: string) =>
  withTenant(db, b.tenantId, (tx) => findCalendarEventSyncOfBooking(tx, bookingId));
const connectionOf = async (b: Business, staffMemberId: StaffMemberId) => {
  const connection = await withTenant(db, b.tenantId, (tx) =>
    findCalendarConnectionOfStaff(tx, staffMemberId),
  );
  if (connection === undefined) throw new Error('not connected');
  return connection;
};
/** The worker's next calendar read (busy times, then "Pepper bookings"), five minutes on. */
const readBack = async (b: Business, staffMemberId: StaffMemberId) => {
  b.clock.advanceBy(5 * MINUTE);
  const connection = await connectionOf(b, staffMemberId);
  return readCalendar(b.deps, b.tenantId, connection.id);
};
const notes = (b: Business) =>
  withTenant(db, b.tenantId, async (tx) =>
    (await listOpenFeedItems(tx, b.clock.now())).filter((item) => item.kind === 'calendar_kept'),
  );

/** A connected staff member with one booking written to "Pepper bookings". */
async function written(b: Business, name = 'Jo', startsAt = '2026-12-02T15:00:00Z') {
  const staff = await aStaffMember(b, name);
  await connect(b, staff.actor);
  const booking = await book(b, staff.staffMemberId, startsAt);
  expect(await write(b, booking.bookingId)).toBe('written');
  const calendarId = (await syncOf(b, booking.bookingId))?.eventCalendarId ?? '';
  return { ...staff, ...booking, calendarId, eventId: calendarEventIdOf(booking.bookingId) };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('reading back with sync tokens (AC-X-175)', () => {
  it('reads the whole calendar first, then only what changed, in resumable pages', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    const second = await book(b, jo.staffMemberId, '2026-12-03T15:00:00Z', 'Beard trim');
    const third = await book(b, jo.staffMemberId, '2026-12-04T15:00:00Z', 'Line up');
    await write(b, second.bookingId);
    await write(b, third.bookingId);
    b.provider.pageSize = 2;

    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    const [first, next] = b.provider.lists.slice(-2);
    expect(first).toMatchObject({ syncToken: null, pageToken: null });
    expect(next?.pageToken).toMatch(/^sbx-page-/u);
    const after = await connectionOf(b, jo.staffMemberId);
    expect(after.eventsSyncToken).toMatch(/^sbx-sync-/u);
    expect(after.eventsPageToken).toBeNull();
    expect(after.eventsReadAt).toEqual(b.clock.now());

    // Nothing changed: one call with the sync token, nothing to do.
    const calls = b.provider.lists.length;
    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    expect(b.provider.lists.slice(calls)).toEqual([
      expect.objectContaining({ syncToken: after.eventsSyncToken, pageToken: null }),
    ]);
    // Pepper's own writes read back change nothing either.
    await run(
      b,
      (q) => `UPDATE bookings SET starts_at = starts_at + interval '1 hour',
      ends_at = ends_at + interval '1 hour' WHERE id = ${q(second.bookingId)}`,
    );
    await write(b, second.bookingId);
    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    expect(await notes(b)).toEqual([]);
    expect((await syncOf(b, second.bookingId))?.keptAt).toBeNull();
  });

  it('reads everything again after a 410, and after a reconnect', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    b.provider.expireSyncTokens();
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, { summary: 'Dentist' });

    const calls = b.provider.lists.length;
    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    const [stale, full] = b.provider.lists.slice(calls);
    expect(stale?.syncToken).toMatch(/^sbx-sync-/u);
    expect(full).toMatchObject({ syncToken: null, pageToken: null });
    // The change was still seen and put back.
    expect((await syncOf(b, jo.bookingId))?.keptAt).toEqual(b.clock.now());

    // A reconnect reads the whole calendar again (its connect read does).
    const before = b.provider.lists.length;
    await connect(b, jo.actor);
    expect(b.provider.lists.slice(before)[0]).toMatchObject({ syncToken: null, pageToken: null });
  });

  it('starts again when a read stops part-way and Google forgets its page', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    for (const day of ['03', '04', '05']) {
      const more = await book(b, jo.staffMemberId, `2026-12-${day}T15:00:00Z`, `Cut ${day}`);
      await write(b, more.bookingId);
    }
    b.provider.pageSize = 1;
    // A read of 10 pages at most: 4 events at 1 a page finish; at a page size of 1 with 12 they
    // wouldn't. Here: the page token kept after a partial read is honoured next time.
    await run(
      b,
      () => `UPDATE calendar_connections SET events_page_token = 'sbx-page-0-1-1',
      events_sync_generation = generation, events_sync_calendar_id = bookings_calendar_id`,
    );
    b.provider.expireSyncTokens();
    const calls = b.provider.lists.length;
    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    const tried = b.provider.lists.slice(calls);
    expect(tried[0]?.pageToken).toBe('sbx-page-0-1-1');
    expect(tried[1]).toMatchObject({ syncToken: null, pageToken: null });
    expect((await connectionOf(b, jo.staffMemberId)).eventsSyncToken).toMatch(/^sbx-sync-1-/u);
  });
});

describe('putting Pepper back (AC-X-176)', () => {
  it('puts a moved event back, with one note to the staff member', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, {
      start: { dateTime: '2026-12-02T17:00:00Z' },
      end: { dateTime: '2026-12-02T17:45:00Z' },
    });

    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    const sync = await syncOf(b, jo.bookingId);
    expect(sync?.syncedVersion).toBe((sync?.version ?? 0) - 1);
    expect(await readBookingCalendarState(b.deps, jo.actor, jo.bookingId)).toEqual({
      state: 'pending',
    });
    expect(await write(b, jo.bookingId)).toBe('written');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)).toMatchObject({
      status: 'confirmed',
      start: { dateTime: '2026-12-02T15:00:00.000Z' },
      end: { dateTime: '2026-12-02T15:45:00.000Z' },
    });
    // The sheet says so (the top-up), for a week.
    expect(await readBookingCalendarState(b.deps, jo.actor, jo.bookingId)).toEqual({
      state: 'written',
      keptOverGoogle: true,
    });
    const [note, ...more] = await notes(b);
    expect(more).toEqual([]);
    expect(note).toMatchObject({
      bookingId: jo.bookingId,
      staffMemberId: jo.staffMemberId,
      audienceStaffId: jo.staffMemberId,
      day: '2026-12-02',
      payload: { change: 'moved', startsAt: '2026-12-02T15:00:00.000Z' },
      clientName: 'Ana María Lopez',
      serviceName: 'Skin fade',
    });
    // Reading back Pepper's own put-back changes nothing more.
    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    expect((await syncOf(b, jo.bookingId))?.syncedVersion).toBe(sync?.version);
    expect(await notes(b)).toHaveLength(1);

    b.clock.advanceBy(8 * DAY);
    expect(await readBookingCalendarState(b.deps, jo.actor, jo.bookingId)).toEqual({
      state: 'written',
    });
  });

  it('brings a deleted event back, and an edited title, updating the one note', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, 'delete');
    await readBack(b, jo.staffMemberId);
    await write(b, jo.bookingId);
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.status).toBe('confirmed');
    expect((await notes(b)).map((n) => n.payload)).toMatchObject([{ change: 'deleted' }]);

    b.provider.changeInGoogle(jo.calendarId, jo.eventId, { summary: 'Lunch with Ana' });
    await readBack(b, jo.staffMemberId);
    await write(b, jo.bookingId);
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.summary).toBe('Skin fade · Ana');
    expect((await notes(b)).map((n) => n.payload)).toMatchObject([{ change: 'edited' }]);
  });

  it('leaves a booking with a write on its way to that write, with no note', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    // Moved in Pepper (queued) and in Google at once: Pepper's move is written, no note.
    await run(
      b,
      (q) => `UPDATE bookings SET starts_at = starts_at + interval '2 hours',
      ends_at = ends_at + interval '2 hours' WHERE id = ${q(jo.bookingId)}`,
    );
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, {
      start: { dateTime: '2026-12-02T19:00:00Z' },
    });
    const version = (await syncOf(b, jo.bookingId))?.version;
    await readBack(b, jo.staffMemberId);
    expect((await syncOf(b, jo.bookingId))?.version).toBe(version);
    expect(await write(b, jo.bookingId)).toBe('written');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.start).toEqual({
      dateTime: '2026-12-02T17:00:00.000Z',
    });
    expect(await notes(b)).toEqual([]);
  });

  it("leaves events Pepper didn't make alone", async () => {
    const b = await aBusiness();
    const jo = await written(b);
    b.provider.addOwnEvent(jo.calendarId, 'dentist0001', 'Dentist');
    await readBack(b, jo.staffMemberId);
    expect(b.provider.seenInGoogle(jo.calendarId, 'dentist0001')?.status).toBe('confirmed');
    expect(b.provider.deletedEvents).toEqual([]);
    expect(await notes(b)).toEqual([]);
  });
});

describe('stray events (AC-X-177)', () => {
  it('removes the old event left in a calendar that needed reconnecting, after the reconnect', async () => {
    const b = await aBusiness();
    const jo = await written(b, 'Jo');
    const sam = await aStaffMember(b, 'Sam');
    await connect(b, sam.actor);
    // Jo's grant is refused; the booking moves to Sam, whose write never waits on Jo.
    await run(
      b,
      () => `UPDATE calendar_connections SET status = 'needs_reconnect',
      access_token_sealed = NULL, access_token_expires_at = NULL
      WHERE staff_member_id = '${StaffMemberIdSchema.parse(jo.staffMemberId)}'`,
    );
    await run(
      b,
      (q) => `UPDATE bookings SET staff_member_id = ${q(sam.staffMemberId)}
      WHERE id = ${q(jo.bookingId)}`,
    );
    expect(await write(b, jo.bookingId)).toBe('written');
    const samCalendar = (await syncOf(b, jo.bookingId))?.eventCalendarId ?? '';
    expect(samCalendar).not.toBe(jo.calendarId);
    expect(b.provider.liveEvents(jo.calendarId).map((e) => e.id)).toEqual([jo.eventId]);

    // Jo reconnects: the connect's read reads Jo's calendar whole and removes the leftover.
    await connect(b, jo.actor);
    expect(b.provider.liveEvents(jo.calendarId)).toEqual([]);
    expect(b.provider.liveEvents(samCalendar).map((e) => e.id)).toEqual([jo.eventId]);
    const sync = await syncOf(b, jo.bookingId);
    expect(sync).toMatchObject({ eventCalendarId: samCalendar, leasedUntil: null });
    expect(sync?.syncedVersion).toBe(sync?.version);
    expect(await notes(b)).toEqual([]);
  });

  it('removes a Pepper event no booking of the business is written under', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    const unknown = calendarEventIdOf(newId());
    b.provider.addOwnEvent(jo.calendarId, unknown, 'Skin fade · Kim');
    await readBack(b, jo.staffMemberId);
    expect(b.provider.seenInGoogle(jo.calendarId, unknown)?.status).toBe('cancelled');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.status).toBe('confirmed');
  });

  it('holds the booking while removing a stray, so a write waits for it', async () => {
    const b = await aBusiness();
    const jo = await written(b, 'Jo');
    const sam = await aStaffMember(b, 'Sam');
    await connect(b, sam.actor);
    // The booking is Sam's and written there; a leftover copy is still in Jo's calendar.
    await run(
      b,
      (q) =>
        `UPDATE bookings SET staff_member_id = ${q(sam.staffMemberId)} WHERE id = ${q(jo.bookingId)}`,
    );
    await run(
      b,
      () => `UPDATE calendar_connections SET status = 'needs_reconnect'
        WHERE staff_member_id = '${StaffMemberIdSchema.parse(jo.staffMemberId)}'`,
    );
    expect(await write(b, jo.bookingId)).toBe('written');
    await run(b, () => `UPDATE calendar_connections SET status = 'connected'`);
    const samCalendar = (await syncOf(b, jo.bookingId))?.eventCalendarId ?? '';
    // A change to Sam's booking is due while Jo's calendar is read.
    await run(
      b,
      (q) => `UPDATE bookings SET starts_at = starts_at + interval '1 hour',
      ends_at = ends_at + interval '1 hour' WHERE id = ${q(jo.bookingId)}`,
    );
    let claimedMeanwhile: string | null = null;
    b.provider.duringDelete = async () => {
      claimedMeanwhile = await write(b, jo.bookingId);
    };
    await run(b, () => `UPDATE calendar_connections SET events_sync_token = NULL`);
    await readBack(b, jo.staffMemberId);
    expect(b.provider.deletedEvents).toEqual([jo.eventId]);
    expect(claimedMeanwhile).toBe('skipped');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.status).toBe('cancelled');
    // Given back after: the write goes out to Sam's calendar.
    expect((await syncOf(b, jo.bookingId))?.leasedUntil).toBeNull();
    expect(await write(b, jo.bookingId)).toBe('written');
    expect(b.provider.seenInGoogle(samCalendar, jo.eventId)).toMatchObject({
      status: 'confirmed',
      start: { dateTime: '2026-12-02T16:00:00.000Z' },
    });
  });

  it('gives back every lease of a page when removing a stray fails', async () => {
    const b = await aBusiness();
    const jo = await written(b, 'Jo');
    const second = await book(b, jo.staffMemberId, '2026-12-03T15:00:00Z', 'Beard trim');
    await write(b, second.bookingId);
    // Both rows point elsewhere: both copies in Jo's calendar are leftovers.
    await run(b, () => `UPDATE calendar_event_syncs SET event_calendar_id = 'elsewhere'`);
    b.provider.deleteFails = [new CalendarProviderError('rate_limited', 429)];
    await readBack(b, jo.staffMemberId);
    for (const id of [jo.bookingId, second.bookingId]) {
      expect((await syncOf(b, id))?.leasedUntil).toBeNull();
    }
  });

  it('never removes an event a write is putting there (an insert whose answer was lost)', async () => {
    const b = await aBusiness();
    const jo = await written(b, 'Jo');
    // The insert reached Google but Pepper never heard: no placement, a retry waiting.
    await run(
      b,
      (q) => `UPDATE calendar_event_syncs SET event_connection_id = NULL, event_calendar_id = NULL,
        version = version + 1, due_at = now() + interval '1 minute', attempts = 1
        WHERE booking_id = ${q(jo.bookingId)}`,
    );
    await readBack(b, jo.staffMemberId);
    expect(b.provider.deletedEvents).toEqual([]);
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.status).toBe('confirmed');
  });
});

describe('what the read-back leaves alone (S71.2 review)', () => {
  it('judges no row written after Google answered: a move in Pepper racing the read', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, { summary: 'Skin fade · Ana ' });
    // While the page is on its way: moved in Pepper and written (the page shows the old time).
    b.provider.afterList = async () => {
      await run(
        b,
        (q) => `UPDATE bookings SET starts_at = starts_at + interval '1 hour',
        ends_at = ends_at + interval '1 hour' WHERE id = ${q(jo.bookingId)}`,
      );
      await write(b, jo.bookingId);
    };
    await readBack(b, jo.staffMemberId);
    expect(await notes(b)).toEqual([]);
    expect((await syncOf(b, jo.bookingId))?.keptAt).toBeNull();
  });

  it('keeps a visit that has ended as it was, even read whole after a rename', async () => {
    const b = await aBusiness();
    // Ended by both the test's clock and the database's (the rename trigger reads the latter).
    const jo = await written(b, 'Jo', '2026-01-05T15:00:00Z');
    await run(
      b,
      () => `UPDATE services SET name = 'Beard trim'
      WHERE id = '${ServiceIdSchema.parse(jo.serviceId)}'`,
    );
    b.provider.changeInGoogle(jo.calendarId, jo.eventId, 'delete');
    await run(b, () => `UPDATE calendar_connections SET events_sync_token = NULL`);
    await readBack(b, jo.staffMemberId);
    expect(await notes(b)).toEqual([]);
    expect((await syncOf(b, jo.bookingId))?.keptAt).toBeNull();
  });
});

describe('renames (AC-X-178)', () => {
  it("writes a renamed service's and client's upcoming events again", async () => {
    const b = await aBusiness();
    const jo = await written(b, 'Jo', '2099-03-02T15:00:00Z');
    await run(
      b,
      () => `UPDATE services SET name = 'Beard trim'
      WHERE id = '${ServiceIdSchema.parse(jo.serviceId)}'`,
    );
    expect(await write(b, jo.bookingId)).toBe('written');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.summary).toBe('Beard trim · Ana');
    await run(
      b,
      () => `UPDATE clients SET name = 'Bea Ruiz'
      WHERE id = '${ClientIdSchema.parse(jo.clientId)}'`,
    );
    expect(await write(b, jo.bookingId)).toBe('written');
    expect(b.provider.seenInGoogle(jo.calendarId, jo.eventId)?.summary).toBe('Beard trim · Bea');
    // Read back: as Pepper wrote it, so nothing is put back.
    await readBack(b, jo.staffMemberId);
    expect(await notes(b)).toEqual([]);
  });
});

describe('a deleted "Pepper bookings" (AC-X-179)', () => {
  it('is noticed by the read and made again with its bookings at the next write pass', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await readBack(b, jo.staffMemberId);
    b.provider.calendars.delete(jo.calendarId);

    expect(await readBack(b, jo.staffMemberId)).toBe('read');
    expect((await connectionOf(b, jo.staffMemberId)).bookingsCalendarId).toBeNull();
    const sync = await syncOf(b, jo.bookingId);
    expect(sync?.eventConnectionId).toBeNull();
    expect(await write(b, jo.bookingId)).toBe('written');
    const remade = (await syncOf(b, jo.bookingId))?.eventCalendarId ?? '';
    expect(remade).not.toBe(jo.calendarId);
    expect(b.provider.liveEvents(remade).map((e) => e.id)).toEqual([jo.eventId]);
    // The new calendar is read whole next time.
    const calls = b.provider.lists.length;
    await readBack(b, jo.staffMemberId);
    expect(b.provider.lists[calls]).toMatchObject({ calendarId: remade, syncToken: null });
  });
});

describe('what the read-back never does', () => {
  it('reads nothing for a connection without the bookings permission, or one needing reconnecting', async () => {
    const b = await aBusiness();
    const jo = await written(b);
    await run(b, () => `UPDATE calendar_connections SET status = 'needs_reconnect'`);
    const connection = await connectionOf(b, jo.staffMemberId);
    expect(await reconcileBookingsCalendar(b.deps, b.tenantId, connection)).toEqual({
      outcome: 'skipped',
      kept: 0,
      removed: 0,
    });
    // An old generation (reconnected since the claim) is skipped too.
    await run(b, () => `UPDATE calendar_connections SET status = 'connected'`);
    expect(
      await reconcileBookingsCalendar(b.deps, b.tenantId, {
        id: connection.id,
        generation: connection.generation - 1,
      }),
    ).toMatchObject({ outcome: 'skipped' });
    // Neither read the calendar.
    expect(b.provider.lists).toEqual([]);
  });

  it("never reads or changes another business's calendar rows", async () => {
    const b = await aBusiness();
    const jo = await written(b);
    const other = await aBusiness();
    const kim = await written(other, 'Kim');
    // Kim's booking's event id put into Jo's calendar: Jo's business doesn't know it, so removes it.
    b.provider.addOwnEvent(jo.calendarId, kim.eventId, 'Skin fade · Ana');
    await readBack(b, jo.staffMemberId);
    expect(b.provider.seenInGoogle(jo.calendarId, kim.eventId)?.status).toBe('cancelled');
    // Kim's row is untouched.
    const kimSync = await syncOf(other, kim.bookingId);
    expect(kimSync).toMatchObject({ leasedUntil: null, keptAt: null });
    expect(kimSync?.syncedVersion).toBe(kimSync?.version);
    expect(other.provider.seenInGoogle(kim.calendarId, kim.eventId)?.status).toBe('confirmed');
  });
});
