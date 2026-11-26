// Google Calendar out (S71, ADR-0069 §10; AC-X-167…173): bookings written as events in
// "Pepper bookings", the duplicate and failure scenarios, the grant and the disconnect, against
// real Postgres with the sandbox (scripted per call).
import {
  BookingIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  calendarEventIdOf,
  type BookingId,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, ManualClock, outboxKeyFrom, type Actor } from '@pepper/core';
import {
  addMembership,
  findCalendarEventSyncOfBooking,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listAuditEntries,
  newId,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBookingCalendarState, writeBookingEvent } from './events.js';
import { insertUser, startTestDatabase, type TestDatabase } from './int-support.js';
import {
  CalendarProviderError,
  type AccessToken,
  type CreateCalendarInput,
  type EventInput,
} from './provider.js';
import { SandboxCalendarProvider } from './sandbox.js';
import {
  completeCalendarConnect,
  disconnectCalendar,
  readOwnCalendar,
  startCalendarConnect,
  type CalendarDeps,
} from './services.js';
import { calendarTokenKeyFrom } from './tokens.js';

const REDIRECT = 'https://app.example/more/calendar/google';
const START = new Date('2026-12-01T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let database: TestDatabase;
let db: Database;
let slugs = 0;

/** The sandbox with failures scripted per call, and the calls counted. */
class Scripted extends SandboxCalendarProvider {
  inserts = 0;
  calendarsMade = 0;
  deletedCalendars: string[] = [];
  revokes = 0;
  refreshFails: CalendarProviderError | null = null;
  /** The next write fails with this, before reaching "Google". */
  writeFails: CalendarProviderError[] = [];
  /** The next insert reaches "Google", then the answer is lost (a timeout). */
  loseNextAnswer = false;
  /** Runs during the next insert, as if a change were made while it was in flight. */
  duringInsert: (() => Promise<void>) | null = null;

  override refresh(token: string): Promise<AccessToken> {
    if (this.refreshFails !== null) return Promise.reject(this.refreshFails);
    return super.refresh(token);
  }

  override createCalendar(input: CreateCalendarInput) {
    this.calendarsMade += 1;
    return super.createCalendar(input);
  }

  override deleteCalendar(input: { accessToken: string; calendarId: string }) {
    this.deletedCalendars.push(input.calendarId);
    return super.deleteCalendar(input);
  }

  override async insertEvent(input: EventInput) {
    this.inserts += 1;
    const failure = this.writeFails.shift();
    if (failure !== undefined) throw failure;
    const during = this.duringInsert;
    this.duringInsert = null;
    if (during !== null) await during();
    const answer = await super.insertEvent(input);
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false;
      throw new CalendarProviderError('unavailable');
    }
    return answer;
  }

  override revoke(token: string) {
    this.revokes += 1;
    return super.revoke(token);
  }

  /** Every event of every calendar that isn't cancelled. */
  allLive() {
    return [...this.calendars.keys()].flatMap((id) =>
      this.liveEvents(id).map((event) => ({ calendarId: id, ...event })),
    );
  }
}

interface Business {
  tenantId: TenantId;
  clock: ManualClock;
  provider: Scripted;
  deps: CalendarDeps;
}

async function aBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'owner');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade Room',
    slug: `gout-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const clock = new ManualClock(START);
  const provider = new Scripted(REDIRECT, () => clock.now().getTime());
  return {
    tenantId: TenantIdSchema.parse(tenant.id),
    clock,
    provider,
    deps: { db, provider, tokenKey: calendarTokenKeyFrom(outboxKeyFrom('y'.repeat(40))), clock },
  };
}

async function aStaffMember(b: Business, name = 'Jo') {
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

async function connect(b: Business, actor: Actor, code = 'sandbox-ok') {
  const { url } = await startCalendarConnect(b.deps, actor);
  const state = new URL(url).searchParams.get('state') ?? '';
  return completeCalendarConnect(b.deps, actor, { code, state });
}

async function book(
  b: Business,
  staffMemberId: StaffMemberId,
  startsAt: string,
): Promise<BookingId> {
  return withTenant(db, b.tenantId, async (tx) => {
    const client = await insertClient(tx, {
      name: 'Ana María Lopez',
      email: `ana-${newId()}@example.test`,
      phone: '+15555550100',
      source: 'team',
    });
    const service = await insertService(tx, {
      name: `Skin fade ${newId().slice(-4)}`,
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
    return BookingIdSchema.parse(row.id);
  });
}

/**
 * A change to a booking as any path would make it, in its business's transaction. Only UUIDs
 * (parsed) are put into the statement.
 */
const change = (b: Business, statement: (uuid: (id: string) => string) => string) =>
  withTenant(db, b.tenantId, (tx: TenantTx) =>
    tx.execute(statement((id) => `'${BookingIdSchema.parse(id)}'`)),
  );

/** This business's bookings' writes only (the scan is across businesses). */
const write = (b: Business, bookingId: string) => writeBookingEvent(b.deps, b.tenantId, bookingId);

const syncOf = (b: Business, bookingId: string) =>
  withTenant(db, b.tenantId, (tx) => findCalendarEventSyncOfBooking(tx, bookingId));

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('the grant (AC-X-167, AC-X-171)', () => {
  it('writes the next 60 days\' bookings into a new "Pepper bookings" calendar', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    const soon = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    const past = await book(b, jo.staffMemberId, '2026-11-30T15:00:00Z');
    const answer = await connect(b, jo.actor);
    expect(answer.connection?.writesBookings).toBe(true);

    expect(await write(b, soon)).toBe('written');
    expect(await syncOf(b, past)).toBeUndefined();
    expect(b.provider.calendarsMade).toBe(1);
    const [event, ...more] = b.provider.allLive();
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      id: calendarEventIdOf(soon),
      start: { dateTime: '2026-12-02T15:00:00.000Z' },
      end: { dateTime: '2026-12-02T15:45:00.000Z' },
      visibility: 'private',
    });
    // The service and the first name, never the rest of the name, the phone or the email.
    expect(event?.summary).toMatch(/^Skin fade \w+ · Ana$/u);
    expect(JSON.stringify(event)).not.toMatch(/Lopez|María|5555|example\.test/u);
    // The audit says the grant included bookings.
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(audit.find((a) => a.action === 'calendar.connected')?.after).toMatchObject({
      writesBookings: true,
    });
  });

  it('writes nothing for a member who unticked the bookings permission', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    const soon = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    const answer = await connect(b, jo.actor, 'sandbox-busy-only');
    expect(answer.connection).toMatchObject({ status: 'connected', writesBookings: false });
    const later = await book(b, jo.staffMemberId, '2026-12-03T15:00:00Z');
    expect(await syncOf(b, soon)).toBeUndefined();
    expect(await syncOf(b, later)).toBeUndefined();
    expect(await readBookingCalendarState(b.deps, jo.actor, later)).toEqual({ state: 'none' });
    expect(b.provider.calendarsMade).toBe(0);
  });
});

describe('keeping the event in step (AC-X-168)', () => {
  it('moves, removes and brings back one event as the booking changes', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    expect(await readBookingCalendarState(b.deps, jo.actor, id)).toEqual({ state: 'pending' });
    expect(await write(b, id)).toBe('written');
    expect(await readBookingCalendarState(b.deps, jo.actor, id)).toEqual({ state: 'written' });
    // Written already: nothing to do.
    expect(await write(b, id)).toBe('skipped');

    await change(
      b,
      (q) => `UPDATE bookings SET starts_at = '2026-12-02T17:00:00Z',
        ends_at = '2026-12-02T17:45:00Z' WHERE id = ${q(id)}`,
    );
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive().map((e) => e.start.dateTime)).toEqual(['2026-12-02T17:00:00.000Z']);

    await change(b, (q) => `UPDATE bookings SET status = 'cancelled' WHERE id = ${q(id)}`);
    expect(await readBookingCalendarState(b.deps, jo.actor, id)).toEqual({ state: 'none' });
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive()).toEqual([]);
    expect(await syncOf(b, id)).toMatchObject({ eventConnectionId: null, eventCalendarId: null });

    // Reinstated: Google kept the deleted event's id, so "already exists" becomes a patch.
    await change(b, (q) => `UPDATE bookings SET status = 'confirmed' WHERE id = ${q(id)}`);
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive().map((e) => e.id)).toEqual([calendarEventIdOf(id)]);

    // Removed (an undone import): its event goes.
    await change(b, (q) => `DELETE FROM bookings WHERE id = ${q(id)}`);
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive()).toEqual([]);
  });

  it("moves the event to another staff member's calendar, or out of every calendar", async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b, 'Jo');
    const sam = await aStaffMember(b, 'Sam');
    const kim = await aStaffMember(b, 'Kim');
    await connect(b, jo.actor);
    await connect(b, sam.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    await write(b, id);
    const joCalendar = (await syncOf(b, id))?.eventCalendarId;

    await change(
      b,
      (q) => `UPDATE bookings SET staff_member_id = ${q(sam.staffMemberId)} WHERE id = ${q(id)}`,
    );
    expect(await write(b, id)).toBe('written');
    const samCalendar = (await syncOf(b, id))?.eventCalendarId;
    expect(samCalendar).not.toBe(joCalendar);
    expect(b.provider.allLive().map((e) => e.calendarId)).toEqual([samCalendar]);

    // Kim has no calendar: the event leaves Sam's and goes nowhere.
    await change(
      b,
      (q) => `UPDATE bookings SET staff_member_id = ${q(kim.staffMemberId)} WHERE id = ${q(id)}`,
    );
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive()).toEqual([]);
    expect(await readBookingCalendarState(b.deps, kim.actor, id)).toEqual({ state: 'none' });
  });
});

describe('duplicates (AC-X-169)', () => {
  it('keeps one event when a write reached Google but the answer was lost', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    b.provider.loseNextAnswer = true;
    expect(await write(b, id)).toBe('failed');
    expect(await syncOf(b, id)).toMatchObject({ attempts: 1, lastError: 'unavailable' });
    // Not again before the backoff.
    expect(await write(b, id)).toBe('skipped');
    b.clock.advanceBy(MINUTE);
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive().map((e) => e.id)).toEqual([calendarEventIdOf(id)]);
  });

  it('lets one of two workers write a booking at a time', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    const outcomes = await Promise.all([write(b, id), write(b, id)]);
    expect(outcomes.sort()).toEqual(['skipped', 'written']);
    expect(b.provider.allLive()).toHaveLength(1);
    expect(b.provider.calendarsMade).toBe(1);
  });

  it('never lets an older change overwrite a newer one', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    // Moved while the first write is on its way to Google.
    b.provider.duringInsert = async () => {
      await change(
        b,
        (q) => `UPDATE bookings SET starts_at = '2026-12-02T18:00:00Z',
          ends_at = '2026-12-02T18:45:00Z' WHERE id = ${q(id)}`,
      );
    };
    expect(await write(b, id)).toBe('written');
    expect(await syncOf(b, id)).toMatchObject({ version: 2, syncedVersion: 1 });
    // Still due for the move: written as the booking is now.
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive().map((e) => e.start.dateTime)).toEqual(['2026-12-02T18:00:00.000Z']);
    expect(await write(b, id)).toBe('skipped');
  });
});

describe('failures (AC-X-170)', () => {
  it('tries a rate-limited write again after the backoff, changing nothing meanwhile', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    b.provider.writeFails = [
      new CalendarProviderError('rate_limited', 429),
      new CalendarProviderError('unavailable', 503),
    ];
    expect(await write(b, id)).toBe('failed');
    b.clock.advanceBy(MINUTE);
    expect(await write(b, id)).toBe('failed');
    expect(await syncOf(b, id)).toMatchObject({ attempts: 2, lastError: 'unavailable' });
    b.clock.advanceBy(MINUTE);
    expect(await write(b, id)).toBe('skipped');
    b.clock.advanceBy(MINUTE);
    expect(await write(b, id)).toBe('written');
    expect(await syncOf(b, id)).toMatchObject({ attempts: 0, lastError: null });
    expect((await readOwnCalendar(b.deps, jo.actor)).connection?.status).toBe('connected');
  });

  it('waits for a reconnect after Google refuses the grant, audited once', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    // The stored access token runs out; the refresh is refused (testing mode's 7 days).
    b.clock.advanceBy(2 * HOUR);
    b.provider.refreshFails = new CalendarProviderError('invalid_grant', 400);
    expect(await write(b, id)).toBe('waiting');
    expect((await readOwnCalendar(b.deps, jo.actor)).connection?.status).toBe('needs_reconnect');
    const second = await book(b, jo.staffMemberId, '2026-12-03T15:00:00Z');
    expect(await write(b, second)).toBe('waiting');
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 20 }));
    expect(audit.filter((a) => a.action === 'calendar.connection_changed')).toHaveLength(1);
    expect(await readBookingCalendarState(b.deps, jo.actor, id)).toEqual({ state: 'pending' });

    // Reconnecting makes both due at once.
    b.provider.refreshFails = null;
    await connect(b, jo.actor);
    expect(await write(b, id)).toBe('written');
    expect(await write(b, second)).toBe('written');
    expect(b.provider.allLive()).toHaveLength(2);
  });

  it('makes "Pepper bookings" again when it was deleted in Google, and writes the bookings back', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const first = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    const other = await book(b, jo.staffMemberId, '2026-12-03T15:00:00Z');
    await write(b, first);
    await write(b, other);
    const old = (await syncOf(b, first))?.eventCalendarId ?? '';
    b.provider.calendars.delete(old);

    await change(
      b,
      (q) => `UPDATE bookings SET starts_at = '2026-12-02T16:00:00Z',
        ends_at = '2026-12-02T16:45:00Z' WHERE id = ${q(first)}`,
    );
    expect(await write(b, first)).toBe('failed');
    // Tried again at once, into a new calendar; the other booking is queued again too.
    expect(await write(b, first)).toBe('written');
    expect(await write(b, other)).toBe('written');
    expect(b.provider.calendarsMade).toBe(2);
    const fresh = (await syncOf(b, first))?.eventCalendarId;
    expect(fresh).not.toBe(old);
    expect(b.provider.liveEvents(fresh ?? '')).toHaveLength(2);
  });
});

describe('disconnecting (AC-X-172)', () => {
  it('stops writing and asks Google to delete "Pepper bookings", then revokes', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b);
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    await write(b, id);
    const calendarId = (await syncOf(b, id))?.eventCalendarId ?? '';
    const revokes = b.provider.revokes;
    await disconnectCalendar(b.deps, jo.actor);
    expect(b.provider.deletedCalendars).toEqual([calendarId]);
    expect(b.provider.revokes).toBe(revokes + 1);
    expect(b.provider.calendars.has(calendarId)).toBe(false);
    // The booking is in no calendar; a change writes nothing.
    await change(
      b,
      (q) => `UPDATE bookings SET starts_at = '2026-12-02T16:00:00Z',
        ends_at = '2026-12-02T16:45:00Z' WHERE id = ${q(id)}`,
    );
    expect(await write(b, id)).toBe('written');
    expect(b.provider.allLive()).toEqual([]);
    expect(await readBookingCalendarState(b.deps, jo.actor, id)).toEqual({ state: 'none' });
  });
});

describe("the sheet's state (AC-X-173)", () => {
  it('answers only for a booking the member may see', async () => {
    const b = await aBusiness();
    const jo = await aStaffMember(b, 'Jo');
    const sam = await aStaffMember(b, 'Sam');
    await connect(b, jo.actor);
    const id = await book(b, jo.staffMemberId, '2026-12-02T15:00:00Z');
    // Staff see their own bookings only.
    expect(await readBookingCalendarState(b.deps, sam.actor, id)).toBeUndefined();
    const other = await aBusiness();
    const kim = await aStaffMember(other, 'Kim');
    expect(await readBookingCalendarState(other.deps, kim.actor, id)).toBeUndefined();
  });
});
