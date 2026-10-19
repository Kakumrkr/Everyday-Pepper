import {
  TenantIdSchema,
  type BookingInput,
  type Client,
  type MembershipRole,
  type Service,
  type RuleDefaults,
  type StaffMember,
  type TemplateId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  ClientNotFoundError,
  createBusiness,
  createClient,
  ForbiddenError,
  getClient,
  listClients,
  lookUpClients,
  ManualClock,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  ClientEmailTakenError,
  listAuditEntries,
  listOccupancy,
  withTenant,
  type Database,
} from '@pepper/db';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingNotStartedError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
  WaitlistEntryNotChangeableError,
  WaitlistExpiredError,
} from './errors.js';
import { findAvailability, type TemplateRuleDefaultsOf } from './services/availability.js';
import {
  changeBooking,
  createBooking,
  getBooking,
  listBookings,
  listBusyTimes,
} from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { replaceBookingRules } from './services/rules.js';
import { createService } from './services/services.js';
import { createStaffMember, updateStaffMember } from './services/staff.js';
import { addToWaitlist, changeWaitlistEntry, listWaitlist } from './services/waitlist.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Clients, bookings, availability and the waitlist through the domain services, against real
// Postgres (ADR-0017): who may book whom (AC-W9-1), the engine's check on every booking, the
// alternatives offered for a refused time (AC-W2-1), idempotent retries, the audit log, and no
// double booking or broken daily cap under concurrency (property tests).

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

// Monday 2 November 2026, 07:00 in New York (EST, after the DST change on 1 November).
const NOW = '2026-11-02T12:00:00.000Z';
/** Tuesday 3 November, `HH:MM` in New York (UTC-5). */
const tue = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, (h ?? 0) + 5, m ?? 0)).toISOString();
};

interface Business {
  tenantId: TenantId;
  owner: Actor;
  manager: Actor;
  /** Jess's login (staff). */
  staff: Actor;
  /** Priya's login (staff), linked to Marco's staff member. */
  colleague: Actor;
  service: Service;
  jess: StaffMember;
  marco: StaffMember;
  /** Maria. */
  client: Client;
  clock: ManualClock;
}

/**
 * Juniper: a 60-minute haircut with 10 minutes' clean-up; Jess (linked to the staff login)
 * offers it and works Monday–Friday 09:00–17:00; Marco (linked to the colleague) works the same
 * hours but offers no service yet. Default rules: 15-minute slots, 2 hours' notice.
 */
async function newBusiness(templateId: TemplateId | null = null): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-bookings-${String(slugs)}`,
    timeZone: 'America/New_York',
    templateId,
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}`,
  });
  const managerId = await insertUser(db, 'Cara');
  const staffId = await insertUser(db, 'Jess');
  const colleagueId = await insertUser(db, 'Priya');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: staffId, role: 'staff' });
    await addMembership(tx, { userId: colleagueId, role: 'staff' });
  });
  const owner = actor(ownerId, 'owner');
  const service = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
    priceFromCents: 6500,
  });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffId,
    serviceIds: [service.id],
  });
  const marco = await createStaffMember(db, owner, { displayName: 'Marco', userId: colleagueId });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  };
  await replaceWorkingHours(db, owner, jess.id, week);
  await replaceWorkingHours(db, owner, marco.id, week);
  const client = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria@example.test',
  });
  return {
    tenantId,
    owner,
    manager: actor(managerId, 'manager'),
    staff: actor(staffId, 'staff'),
    colleague: actor(colleagueId, 'staff'),
    service,
    jess,
    marco,
    client,
    clock: new ManualClock(NOW),
  };
}

function request(b: Business, startsAt: string, extra: Partial<BookingInput> = {}): BookingInput {
  return {
    clientId: b.client.id,
    serviceId: b.service.id,
    staffMemberId: b.jess.id,
    startsAt,
    ...extra,
  };
}

/**
 * Books Maria with Jess on Monday at 16:00, so Jess (staff) may see Maria and book her again:
 * staff reach only the clients they have a booking or waitlist entry with (AC-W9-1).
 */
async function introduce(b: Business): Promise<void> {
  await book(b, b.owner, request(b, '2026-11-02T21:00:00.000Z'));
}

function book(b: Business, actor: Actor, input: BookingInput) {
  return createBooking(db, actor, input, { clock: b.clock });
}

async function refusal(promise: Promise<unknown>): Promise<SlotUnavailableError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SlotUnavailableError);
  return error as SlotUnavailableError;
}

async function auditOf(tenantId: TenantId) {
  return withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
}

describe('createBooking', () => {
  it('books an offered time, with a copy of the service and an audit entry without client details', async () => {
    const b = await newBusiness();
    const booking = await book(b, b.owner, request(b, tue('10:00')));
    expect(booking).toMatchObject({
      clientId: b.client.id,
      staffMemberId: b.jess.id,
      startsAt: tue('10:00'),
      endsAt: tue('11:00'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 10,
      priceFromCents: 6500,
      status: 'confirmed',
      source: 'team',
      overridden: false,
    });
    const [entry] = await auditOf(b.tenantId);
    expect(entry).toMatchObject({
      action: 'booking.created',
      actor: { kind: 'user', userId: b.owner.context.userId },
      entity: { type: 'booking', id: booking.id },
      before: null,
    });
    expect(JSON.stringify(entry)).not.toMatch(/Maria|maria@/);
  });

  it('records where a booking came from (the AI employee in Phase 6)', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.owner, request(b, tue('10:00')), {
      clock: b.clock,
      source: 'ai',
    });
    expect(booking.source).toBe('ai');
  });

  it.each([
    ['before opening', '08:00'],
    ['running past closing', '16:30'],
    ['off the 15-minute grid', '10:05'],
  ])('refuses a time %s and offers the 3 nearest instead', async (_label, time) => {
    const b = await newBusiness();
    const { alternatives } = await refusal(book(b, b.owner, request(b, tue(time))));
    expect(alternatives).toHaveLength(3);
    const offered = await findAvailability(
      db,
      b.owner,
      { serviceId: b.service.id, staffMemberId: b.jess.id, from: NOW, to: tue('23:59') },
      { clock: b.clock },
    );
    for (const alternative of alternatives) expect(offered).toContainEqual(alternative);
  });

  it('AC-W2-1: refuses an overlap (buffers included) and offers the nearest valid times', async () => {
    const b = await newBusiness();
    await book(b, b.owner, request(b, tue('14:00')));
    // 15:00 falls in the 10-minute clean-up after the 14:00 haircut.
    const { alternatives } = await refusal(book(b, b.owner, request(b, tue('15:00'))));
    expect(alternatives.map((a) => a.startsAt)).toEqual([tue('15:15'), tue('15:30'), tue('15:45')]);
  });

  it('refuses a time inside the minimum notice; alternatives start after it', async () => {
    const b = await newBusiness();
    b.clock.set(tue('09:30'));
    const { alternatives } = await refusal(book(b, b.owner, request(b, tue('10:00'))));
    // Two hours' notice from 09:30: 11:30 is the first time.
    expect(alternatives.map((a) => a.startsAt)).toEqual([tue('11:30'), tue('11:45'), tue('12:00')]);
  });

  it('owners and managers may override hours and rules, never an overlap', async () => {
    const b = await newBusiness();
    const late = await book(b, b.manager, request(b, tue('17:05'), { override: true }));
    expect(late).toMatchObject({ startsAt: tue('17:05'), overridden: true });
    await refusal(book(b, b.owner, request(b, tue('17:30'), { override: true })));
  });

  it("an override still needs a staff member who offers the service; staff can't override", async () => {
    const b = await newBusiness();
    await refusal(
      book(b, b.owner, request(b, tue('10:00'), { staffMemberId: b.marco.id, override: true })),
    );
    await expect(
      book(b, b.staff, request(b, tue('17:05'), { override: true })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('AC-W9-1: staff book only their own staff member', async () => {
    const b = await newBusiness();
    await introduce(b);
    const own = await book(b, b.staff, request(b, tue('10:00')));
    expect(own.staffMemberId).toBe(b.jess.id);
    await expect(book(b, b.colleague, request(b, tue('12:00')))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("staff can't book a client they have no booking with", async () => {
    const b = await newBusiness();
    const lee = await createClient(db, b.owner, { name: 'Lee' });
    await expect(
      book(b, b.staff, request(b, tue('10:00'), { clientId: lee.id })),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
    // Once the business books Lee with Jess, Jess can book Lee again.
    await book(b, b.owner, request(b, tue('10:00'), { clientId: lee.id }));
    await expect(
      book(b, b.staff, request(b, tue('12:00'), { clientId: lee.id })),
    ).resolves.toBeDefined();
  });

  it("another business's or unknown ids are not found", async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    await expect(
      book(b, b.owner, request(b, tue('10:00'), { serviceId: other.service.id })),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      book(b, b.owner, request(b, tue('10:00'), { staffMemberId: other.jess.id })),
    ).rejects.toBeInstanceOf(StaffMemberNotFoundError);
    await expect(
      book(b, b.owner, request(b, tue('10:00'), { clientId: other.client.id })),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
  });

  it('validates the request before the database', async () => {
    const b = await newBusiness();
    await expect(
      book(b, b.owner, { ...request(b, tue('10:00')), startsAt: '2026-11-03T10:00:00-05:00' }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('a retry with the same idempotency key returns the first booking', async () => {
    const b = await newBusiness();
    const keyed = request(b, tue('10:00'), { idempotencyKey: 'tool-call-0001' });
    const first = await book(b, b.owner, keyed);
    expect(await book(b, b.owner, keyed)).toEqual(first);
    // Concurrent retries all get it too.
    const retries = await Promise.all([1, 2, 3].map(() => book(b, b.owner, keyed)));
    for (const retry of retries) expect(retry).toEqual(first);
    const created = (await auditOf(b.tenantId)).filter((e) => e.action === 'booking.created');
    expect(created).toHaveLength(1);
    await expect(book(b, b.owner, { ...keyed, startsAt: tue('12:00') })).rejects.toBeInstanceOf(
      IdempotencyKeyReusedError,
    );
  });

  it('concurrent first attempts with one key create one booking', async () => {
    const b = await newBusiness();
    const keyed = request(b, tue('10:00'), { idempotencyKey: 'tool-call-0002' });
    const results = await Promise.all([1, 2, 3, 4].map(() => book(b, b.owner, keyed)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });
});

describe('reading bookings', () => {
  it('AC-W9-1: staff read only their own bookings; everyone reads busy times', async () => {
    const b = await newBusiness();
    await updateStaffMember(db, b.owner, b.marco.id, {
      displayName: 'Marco',
      userId: b.colleague.context.userId,
      serviceIds: [b.service.id],
    });
    const jess = await book(b, b.owner, request(b, tue('10:00')));
    const marco = await book(b, b.owner, request(b, tue('10:00'), { staffMemberId: b.marco.id }));
    const range = { from: tue('00:00'), to: tue('23:59') };

    expect(await listBookings(db, b.owner, range)).toEqual(
      [jess, marco].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(await listBookings(db, b.staff, range)).toEqual([jess]);
    expect(await listBookings(db, b.staff, { ...range, staffMemberId: b.marco.id })).toEqual([]);
    expect(await getBooking(db, b.staff, jess.id)).toEqual(jess);
    await expect(getBooking(db, b.staff, marco.id)).rejects.toBeInstanceOf(BookingNotFoundError);
    expect(await getBooking(db, b.manager, marco.id)).toEqual(marco);

    const busy = await listBusyTimes(db, b.staff, range);
    expect(busy.map((t) => t.staffMemberId).sort()).toEqual([b.jess.id, b.marco.id].sort());
    expect(busy[0]).toMatchObject({
      startsAt: tue('10:00'),
      endsAt: tue('11:00'),
      occupiedFrom: tue('10:00'),
      occupiedTo: tue('11:10'),
    });
    expect(await listBusyTimes(db, b.staff, { ...range, staffMemberId: b.marco.id })).toHaveLength(
      1,
    );
  });

  it('staff get the same availability as owners', async () => {
    const b = await newBusiness();
    await book(b, b.owner, request(b, tue('10:00')));
    const query = { serviceId: b.service.id, from: tue('00:00'), to: tue('23:59') };
    const forOwner = await findAvailability(db, b.owner, query, { clock: b.clock });
    expect(await findAvailability(db, b.colleague, query, { clock: b.clock })).toEqual(forOwner);
    // Jess's 10:00 haircut occupies 10:00–11:10; a 09:00 one's clean-up would run into it.
    expect(forOwner[0]?.startsAt).toBe(tue('11:15'));
    // Marco offers no service: only Jess's slots.
    expect(new Set(forOwner.map((s) => s.staffMemberId))).toEqual(new Set([b.jess.id]));
  });

  it('a limit keeps the earliest bookings, busy times and start times', async () => {
    const b = await newBusiness();
    const early = await book(b, b.owner, request(b, tue('10:00')));
    await book(b, b.owner, request(b, tue('14:00')));
    const range = { from: tue('00:00'), to: tue('23:59') };
    expect(await listBookings(db, b.owner, range, { limit: 1 })).toEqual([early]);
    expect((await listBusyTimes(db, b.staff, range, { limit: 1 })).map((t) => t.startsAt)).toEqual([
      tue('10:00'),
    ]);
    const query = { serviceId: b.service.id, ...range };
    const all = await findAvailability(db, b.owner, query, { clock: b.clock });
    expect(all.length).toBeGreaterThan(2);
    expect(await findAvailability(db, b.owner, query, { clock: b.clock, limit: 2 })).toEqual(
      all.slice(0, 2),
    );
  });

  it('availability: unknown service or staff member; at most 62 days', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    const range = { from: tue('00:00'), to: tue('23:59') };
    await expect(
      findAvailability(db, b.owner, { ...range, serviceId: other.service.id }),
    ).rejects.toBeInstanceOf(ServiceNotFoundError);
    await expect(
      findAvailability(db, b.owner, {
        ...range,
        serviceId: b.service.id,
        staffMemberId: other.jess.id,
      }),
    ).rejects.toBeInstanceOf(StaffMemberNotFoundError);
    await expect(
      findAvailability(db, b.owner, {
        serviceId: b.service.id,
        from: NOW,
        to: '2027-01-04T12:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe('changeBooking', () => {
  it('moves a booking to a free time, also overlapping its own old time, and audits it', async () => {
    const b = await newBusiness();
    await introduce(b);
    const booking = await book(b, b.staff, request(b, tue('10:00')));
    const moved = await changeBooking(
      db,
      b.staff,
      booking.id,
      { startsAt: tue('10:15') },
      { clock: b.clock },
    );
    expect(moved).toMatchObject({ id: booking.id, startsAt: tue('10:15'), endsAt: tue('11:15') });
    const [entry] = await auditOf(b.tenantId);
    expect(entry).toMatchObject({
      action: 'booking.updated',
      before: { startsAt: tue('10:00') },
      after: { startsAt: tue('10:15') },
    });
  });

  it('refuses a move onto a taken time, with alternatives', async () => {
    const b = await newBusiness();
    await book(b, b.owner, request(b, tue('14:00')));
    const booking = await book(b, b.owner, request(b, tue('10:00')));
    const { alternatives } = await refusal(
      changeBooking(db, b.owner, booking.id, { startsAt: tue('14:30') }, { clock: b.clock }),
    );
    // The nearest to 14:30 after the 14:00 haircut and its clean-up.
    expect(alternatives.map((a) => a.startsAt)).toEqual([tue('15:15'), tue('15:30'), tue('15:45')]);
  });

  it('moves to another staff member who offers the service; staff only between their own', async () => {
    const b = await newBusiness();
    const booking = await book(b, b.owner, request(b, tue('10:00')));
    await refusal(
      changeBooking(
        db,
        b.owner,
        booking.id,
        { startsAt: tue('10:00'), staffMemberId: b.marco.id },
        { clock: b.clock },
      ),
    );
    await updateStaffMember(db, b.owner, b.marco.id, {
      displayName: 'Marco',
      userId: b.colleague.context.userId,
      serviceIds: [b.service.id],
    });
    await expect(
      changeBooking(
        db,
        b.staff,
        booking.id,
        { startsAt: tue('10:00'), staffMemberId: b.marco.id },
        { clock: b.clock },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const moved = await changeBooking(
      db,
      b.manager,
      booking.id,
      { startsAt: tue('10:00'), staffMemberId: b.marco.id },
      { clock: b.clock },
    );
    expect(moved.staffMemberId).toBe(b.marco.id);
    // Now it is Marco's: Jess can't see it, Priya can.
    await expect(getBooking(db, b.staff, booking.id)).rejects.toBeInstanceOf(BookingNotFoundError);
    expect(await getBooking(db, b.colleague, booking.id)).toEqual(moved);
  });

  it("staff can't change a colleague's booking: it is not even found", async () => {
    const b = await newBusiness();
    const booking = await book(b, b.owner, request(b, tue('10:00')));
    await expect(
      changeBooking(db, b.colleague, booking.id, { status: 'cancelled' }),
    ).rejects.toBeInstanceOf(BookingNotFoundError);
  });

  it('cancelling frees the time; a cancelled booking is final', async () => {
    const b = await newBusiness();
    await introduce(b);
    const booking = await book(b, b.staff, request(b, tue('10:00')));
    const cancelled = await changeBooking(db, b.staff, booking.id, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    await expect(book(b, b.owner, request(b, tue('10:00')))).resolves.toBeDefined();
    await expect(
      changeBooking(db, b.owner, booking.id, { status: 'completed' }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
    await expect(
      changeBooking(db, b.owner, booking.id, { startsAt: tue('12:00') }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
  });

  it('completed and no-show only once it has started; then it can no longer move', async () => {
    const b = await newBusiness();
    const booking = await book(b, b.owner, request(b, tue('10:00')));
    await expect(
      changeBooking(db, b.owner, booking.id, { status: 'completed' }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotStartedError);
    b.clock.set(tue('10:00'));
    const done = await changeBooking(
      db,
      b.owner,
      booking.id,
      { status: 'no_show' },
      { clock: b.clock },
    );
    expect(done.status).toBe('no_show');
    const fixed = await changeBooking(
      db,
      b.owner,
      booking.id,
      { status: 'completed' },
      { clock: b.clock },
    );
    expect(fixed.status).toBe('completed');
    await expect(
      changeBooking(db, b.owner, booking.id, { status: 'completed' }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
    await expect(
      changeBooking(db, b.owner, booking.id, { startsAt: tue('15:00') }, { clock: b.clock }),
    ).rejects.toBeInstanceOf(BookingNotChangeableError);
  });

  it('staff record completed or no-show once; only owners and managers correct it', async () => {
    const b = await newBusiness();
    await introduce(b);
    const booking = await book(b, b.staff, request(b, tue('10:00')));
    b.clock.set(tue('11:00'));
    const status = (actor: Actor, to: 'completed' | 'no_show' | 'cancelled') =>
      changeBooking(db, actor, booking.id, { status: to }, { clock: b.clock });
    expect((await status(b.staff, 'no_show')).status).toBe('no_show');
    await expect(status(b.staff, 'completed')).rejects.toBeInstanceOf(BookingNotChangeableError);
    await expect(status(b.staff, 'cancelled')).rejects.toBeInstanceOf(BookingNotChangeableError);
    expect((await status(b.manager, 'completed')).status).toBe('completed');
    expect((await status(b.owner, 'cancelled')).status).toBe('cancelled');
  });
});

describe('clients', () => {
  it('owners and managers add clients; staff cannot; the audit entry keeps only the source', async () => {
    const b = await newBusiness();
    const lee = await createClient(db, b.manager, { name: 'Lee', phone: '+15551234567' });
    expect(lee).toMatchObject({ name: 'Lee', email: null, phone: '+15551234567', source: 'team' });
    await expect(createClient(db, b.staff, { name: 'Walk-in' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(
      createClient(db, b.owner, { name: 'Maria again', email: 'MARIA@example.test' }),
    ).rejects.toBeInstanceOf(ClientEmailTakenError);
    const [entry] = await auditOf(b.tenantId);
    expect(entry).toMatchObject({
      action: 'client.created',
      entity: { type: 'client', id: lee.id },
      after: { source: 'team' },
    });
  });

  it('AC-W9-1: staff see only clients they have a booking or waitlist entry with', async () => {
    const b = await newBusiness();
    const lee = await createClient(db, b.owner, { name: 'Lee' });
    expect(await listClients(db, b.staff)).toEqual([]);
    await expect(getClient(db, b.staff, b.client.id)).rejects.toBeInstanceOf(ClientNotFoundError);

    await book(b, b.owner, request(b, tue('10:00')));
    expect(await listClients(db, b.staff)).toEqual([b.client]);
    expect(await getClient(db, b.staff, b.client.id)).toEqual(b.client);

    await addToWaitlist(
      db,
      b.owner,
      {
        clientId: lee.id,
        serviceId: b.service.id,
        staffMemberId: b.jess.id,
        windows: [{ date: '2026-11-05', start: '09:00', end: '12:00' }],
      },
      { clock: b.clock },
    );
    expect((await listClients(db, b.staff)).map((c) => c.name)).toEqual(['Lee', 'Maria Lopez']);
    expect(await listClients(db, b.colleague)).toEqual([]);
    expect((await listClients(db, b.owner, { search: 'lop' })).map((c) => c.name)).toEqual([
      'Maria Lopez',
    ]);
  });
});

describe('finding a client by exact email or phone (ADR-0020)', () => {
  it('staff find any client by exact email or phone, never by a part of it', async () => {
    const b = await newBusiness();
    const lee = await createClient(db, b.owner, { name: 'Lee', phone: '+15551234567' });
    expect(await lookUpClients(db, b.staff, { contact: 'MARIA@example.test' })).toEqual([b.client]);
    expect(await lookUpClients(db, b.colleague, { contact: '+15551234567' })).toEqual([lee]);
    expect(await lookUpClients(db, b.owner, { contact: '+15559999999' })).toEqual([]);
    await expect(lookUpClients(db, b.staff, { contact: 'maria' })).rejects.toBeInstanceOf(ZodError);
    // Finding them shows only them, and only then: the staff member still lists no one.
    expect(await listClients(db, b.staff)).toEqual([]);
  });

  it('staff book a client they found, with the contact they found them by', async () => {
    const b = await newBusiness();
    await expect(book(b, b.staff, request(b, tue('10:00')))).rejects.toBeInstanceOf(
      ClientNotFoundError,
    );
    await expect(
      book(b, b.staff, request(b, tue('10:00'), { clientContact: 'someone@example.test' })),
    ).rejects.toBeInstanceOf(ClientNotFoundError);
    const booking = await book(
      b,
      b.staff,
      request(b, tue('10:00'), { clientContact: 'maria@example.test' }),
    );
    expect(booking).toMatchObject({ clientId: b.client.id, staffMemberId: b.jess.id });
    // Now Maria is Jess's client like any other.
    expect(await listClients(db, b.staff)).toEqual([b.client]);
    // The contact never lets staff book for a colleague.
    await expect(
      book(
        b,
        b.staff,
        request(b, tue('13:00'), {
          staffMemberId: b.marco.id,
          clientContact: 'maria@example.test',
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('staff add a client they found to their waitlist', async () => {
    const b = await newBusiness();
    const entry = {
      clientId: b.client.id,
      serviceId: b.service.id,
      staffMemberId: b.jess.id,
      windows: [{ date: '2026-11-05', start: '09:00', end: '12:00' }],
    };
    await expect(addToWaitlist(db, b.staff, entry, { clock: b.clock })).rejects.toBeInstanceOf(
      ClientNotFoundError,
    );
    const added = await addToWaitlist(
      db,
      b.staff,
      { ...entry, clientContact: 'maria@example.test' },
      { clock: b.clock },
    );
    expect(added).toMatchObject({ clientId: b.client.id, status: 'waiting' });
    expect(added).not.toHaveProperty('clientContact');
  });
});

describe('waitlist', () => {
  const windows = [{ date: '2026-11-05', start: '09:00', end: '12:00' }];

  it('adds, lists and cancels entries, audited without client details', async () => {
    const b = await newBusiness();
    const entry = await addToWaitlist(
      db,
      b.owner,
      { clientId: b.client.id, serviceId: b.service.id, windows },
      { clock: b.clock },
    );
    // 12:00 EST on 5 November.
    expect(entry).toMatchObject({
      status: 'waiting',
      staffMemberId: null,
      expiresAt: '2026-11-05T17:00:00.000Z',
    });
    expect(await listWaitlist(db, b.manager, {}, { clock: b.clock })).toEqual([entry]);

    const cancelled = await changeWaitlistEntry(db, b.owner, entry.id, { status: 'cancelled' });
    expect(cancelled.status).toBe('cancelled');
    expect(await listWaitlist(db, b.owner, {}, { clock: b.clock })).toEqual([]);
    expect(await listWaitlist(db, b.owner, { all: 'true' }, { clock: b.clock })).toEqual([
      cancelled,
    ]);
    await expect(
      changeWaitlistEntry(db, b.owner, entry.id, { status: 'cancelled' }),
    ).rejects.toBeInstanceOf(WaitlistEntryNotChangeableError);

    const actions = (await auditOf(b.tenantId)).map((e) => e.action);
    expect(actions.slice(0, 2)).toEqual(['waitlist_entry.updated', 'waitlist_entry.created']);
    const waitlistEntries = (await auditOf(b.tenantId)).filter((e) =>
      e.action.startsWith('waitlist'),
    );
    expect(JSON.stringify(waitlistEntries)).not.toMatch(/09:00|12:00|2026-11-05"|Maria/);
  });

  it('an entry whose windows have all passed is refused; one that has since passed reads as expired', async () => {
    const b = await newBusiness();
    await expect(
      addToWaitlist(
        db,
        b.owner,
        {
          clientId: b.client.id,
          serviceId: b.service.id,
          windows: [{ date: '2026-11-02', start: '01:00', end: '06:00' }],
        },
        { clock: b.clock },
      ),
    ).rejects.toBeInstanceOf(WaitlistExpiredError);
    const entry = await addToWaitlist(
      db,
      b.owner,
      { clientId: b.client.id, serviceId: b.service.id, windows },
      { clock: b.clock },
    );
    b.clock.set('2026-11-05T17:00:00.000Z');
    expect(await listWaitlist(db, b.owner, {}, { clock: b.clock })).toEqual([]);
    expect(await listWaitlist(db, b.owner, { all: 'true' }, { clock: b.clock })).toEqual([
      { ...entry, status: 'expired' },
    ]);
  });

  it('AC-W9-1: staff manage only entries for their own staff member', async () => {
    const b = await newBusiness();
    await book(b, b.owner, request(b, tue('10:00')));
    const own = await addToWaitlist(
      db,
      b.staff,
      { clientId: b.client.id, serviceId: b.service.id, staffMemberId: b.jess.id, windows },
      { clock: b.clock },
    );
    await expect(
      addToWaitlist(
        db,
        b.staff,
        { clientId: b.client.id, serviceId: b.service.id, windows },
        { clock: b.clock },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      addToWaitlist(
        db,
        b.staff,
        { clientId: b.client.id, serviceId: b.service.id, staffMemberId: b.marco.id, windows },
        { clock: b.clock },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const anyone = await addToWaitlist(
      db,
      b.owner,
      { clientId: b.client.id, serviceId: b.service.id, windows },
      { clock: b.clock },
    );
    expect(await listWaitlist(db, b.staff, {}, { clock: b.clock })).toEqual([own]);
    expect(await listWaitlist(db, b.colleague, {}, { clock: b.clock })).toEqual([]);
    await expect(
      changeWaitlistEntry(db, b.staff, anyone.id, { status: 'cancelled' }),
    ).rejects.toThrow();
    expect((await changeWaitlistEntry(db, b.staff, own.id, { status: 'cancelled' })).status).toBe(
      'cancelled',
    );
  });
});

describe('under concurrency (property tests)', () => {
  /** The `n`-th weekday from Monday 9 November 2026 (UTC midnight), a fresh day per run. */
  const weekday = (n: number) => new Date(Date.UTC(2026, 10, 9 + Math.floor(n / 5) * 7 + (n % 5)));

  /** Every pair of active bookings of one staff member, buffers included, is apart. */
  async function assertNoOverlap(b: Business) {
    const occupied = await withTenant(db, b.tenantId, (tx) =>
      listOccupancy(tx, { from: new Date('2026-01-01'), to: new Date('2027-01-01') }),
    );
    for (const [i, a] of occupied.entries()) {
      for (const c of occupied.slice(i + 1)) {
        if (a.staffMemberId !== c.staffMemberId) continue;
        expect(a.occupiedTo <= c.occupiedFrom || c.occupiedTo <= a.occupiedFrom).toBe(true);
      }
    }
    return occupied;
  }

  it('concurrent bookings and moves never double-book, and every request either succeeds or gets alternatives', async () => {
    const b = await newBusiness();
    await updateStaffMember(db, b.owner, b.marco.id, {
      displayName: 'Marco',
      userId: b.colleague.context.userId,
      serviceIds: [b.service.id],
    });
    let day = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            staff: fc.integer({ min: 0, max: 1 }),
            // 09:00 … 16:00 local in 15-minute steps.
            slot: fc.integer({ min: 0, max: 28 }),
            override: fc.boolean(),
          }),
          { minLength: 2, maxLength: 12 },
        ),
        async (requests) => {
          const date = weekday(day++);
          const at = (slot: number) =>
            new Date(date.getTime() + (14 * 60 + slot * 15) * 60_000).toISOString();
          const results = await Promise.allSettled(
            requests.map((r) =>
              book(
                b,
                b.owner,
                request(b, at(r.slot), {
                  staffMemberId: r.staff === 0 ? b.jess.id : b.marco.id,
                  override: r.override,
                }),
              ),
            ),
          );
          for (const result of results) {
            if (result.status === 'rejected')
              expect(result.reason).toBeInstanceOf(SlotUnavailableError);
          }
          expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
          await assertNoOverlap(b);
        },
      ),
      { numRuns: 40, seed: 20261017 },
    );
  });

  it('concurrent bookings never exceed the daily cap', async () => {
    const b = await newBusiness();
    await replaceBookingRules(db, b.owner, {
      rules: [
        {
          type: 'max_bookings_per_day',
          version: 1,
          staffMemberId: b.jess.id,
          params: { count: 2 },
        },
      ],
    });
    let day = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 0, max: 7 }), { minLength: 3, maxLength: 8 }),
        async (hours) => {
          const date = weekday(day++);
          // Whole hours from 09:00 local: never overlapping, so only the cap can refuse.
          const results = await Promise.allSettled(
            hours.map((h) =>
              book(
                b,
                b.owner,
                request(b, new Date(date.getTime() + (14 + h) * 3_600_000).toISOString()),
              ),
            ),
          );
          expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
        },
      ),
      { numRuns: 15, seed: 20261018 },
    );
  });
});

describe('industry template defaults (ADR-0018)', () => {
  // A stand-in for `@pepper/templates` (the app passes the real one; modules do not import it).
  // Its values are made up to check the plumbing: a "barber" business gets a 30-minute grid and
  // 30 minutes' notice. The api journey test uses the real templates.
  const asked: (TemplateId | null)[] = [];
  const templateRuleDefaults: TemplateRuleDefaultsOf = (templateId) => {
    asked.push(templateId);
    const barber: Partial<RuleDefaults> = { slotIntervalMinutes: 30, minimumNoticeMinutes: 30 };
    return templateId === 'barber' ? barber : {};
  };
  const tuesday = (b: Business) => ({
    serviceId: b.service.id,
    staffMemberId: b.jess.id,
    from: tue('00:00'),
    to: tue('23:59'),
  });

  it("offers times on the template's grid when the business has no rule of its own", async () => {
    const b = await newBusiness('barber');
    asked.length = 0;
    const slots = await findAvailability(db, b.owner, tuesday(b), {
      clock: b.clock,
      templateRuleDefaults,
    });
    expect(asked).toEqual(['barber']);
    expect(slots.slice(0, 3).map((s) => s.startsAt)).toEqual([
      tue('09:00'),
      tue('09:30'),
      tue('10:00'),
    ]);
    expect(slots.every((s) => new Date(s.startsAt).getUTCMinutes() % 30 === 0)).toBe(true);
  });

  it("uses the template's notice: 30 minutes, not the platform's 2 hours", async () => {
    const b = await newBusiness('barber');
    b.clock.set(tue('09:40'));
    const slots = await findAvailability(db, b.owner, tuesday(b), {
      clock: b.clock,
      templateRuleDefaults,
    });
    expect(slots[0]?.startsAt).toBe(tue('10:30'));
  });

  it("lets the business's own rule win over the template", async () => {
    const b = await newBusiness('barber');
    await replaceBookingRules(db, b.owner, {
      rules: [{ type: 'slot_interval', params: { minutes: 20 } }],
    });
    const slots = await findAvailability(db, b.owner, tuesday(b), {
      clock: b.clock,
      templateRuleDefaults,
    });
    expect(slots.slice(0, 3).map((s) => s.startsAt)).toEqual([
      tue('09:00'),
      tue('09:20'),
      tue('09:40'),
    ]);
  });

  it("refuses a booking off the template's grid, with alternatives on it, and moves alike", async () => {
    const b = await newBusiness('barber');
    const options = { clock: b.clock, templateRuleDefaults };
    const { alternatives } = await refusal(
      createBooking(db, b.owner, request(b, tue('10:15')), options),
    );
    expect(alternatives.map((a) => a.startsAt)).toEqual([tue('10:00'), tue('10:30'), tue('09:30')]);

    const booking = await createBooking(db, b.owner, request(b, tue('10:30')), options);
    await refusal(changeBooking(db, b.owner, booking.id, { startsAt: tue('13:15') }, options));
    const moved = await changeBooking(db, b.owner, booking.id, { startsAt: tue('13:30') }, options);
    expect(moved.startsAt).toBe(tue('13:30'));
  });

  it('asks for no template for a business without one, and keeps the platform defaults', async () => {
    const b = await newBusiness();
    asked.length = 0;
    const slots = await findAvailability(db, b.owner, tuesday(b), {
      clock: b.clock,
      templateRuleDefaults,
    });
    expect(asked).toEqual([null]);
    expect(slots[1]?.startsAt).toBe(tue('09:15'));
  });
});
