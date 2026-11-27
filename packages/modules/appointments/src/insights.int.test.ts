import {
  BookingIdSchema,
  TenantIdSchema,
  type Booking,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
} from '@pepper/contracts';
import {
  changeFeedSettings,
  createBusiness,
  createClient,
  ManualClock,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  listOpenFeedItems,
  listVisitRisks,
  markBookingConfirmAsked,
  readFeedSettings,
  withMember,
  withTenant,
  writeFeedSettings,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeBooking, createBooking } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { addTimeOff } from './services/time-off.js';
import { runDueInsights, runInsightsFor, type InsightsOptions } from './services/insights.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The insights pass against real Postgres (S35, ADR-0039): a new business runs on the first
// pass, a booking change asks for a run that updates the gap, a re-run changes nothing, the
// pause and a kind turned off are honoured, and staff see only their own items.

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
const MINUTE = 60_000;

interface Business {
  tenantId: TenantId;
  owner: Actor;
  staffUser: Parameters<typeof withMember>[1]['userId'];
  service: Service;
  jess: StaffMember;
  maria: Client;
  clock: ManualClock;
  options: InsightsOptions;
}

/** Jess (linked to a staff login) works Mon–Fri 09:00–17:00; a 60-minute haircut. */
async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-insights-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const staffUser = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffUser, role: 'staff' }));
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffUser,
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
  const maria = await createClient(db, owner, { name: 'Maria Lopez', email: 'maria@example.test' });
  const clock = new ManualClock(NOW);
  return {
    tenantId,
    owner,
    staffUser,
    service,
    jess,
    maria,
    clock,
    options: {
      clock,
      insightsOf: () => ({
        enabled: ['schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload'],
        minGapMinutes: 60,
      }),
    },
  };
}

const feed = async (b: Business, at = new Date(NOW)) =>
  withTenant(db, b.tenantId, (tx) => listOpenFeedItems(tx, at, 200));
const gapOn = async (b: Business, day: string) =>
  (await feed(b)).find((item) => item.kind === 'schedule_gaps' && item.day === day);

describe('the insights pass', () => {
  it('runs a new business on the first pass, and not again until something asks', async () => {
    const b = await newBusiness();
    const first = await runDueInsights(db, b.options);
    expect(first.businesses).toBeGreaterThanOrEqual(1);
    // Mon–Fri in the 7 days from Monday: five gap items, all of Jess's day.
    const gaps = (await feed(b)).filter((item) => item.kind === 'schedule_gaps');
    expect(gaps.map((item) => item.day).sort()).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
    ]);
    expect(gaps[0]).toMatchObject({ audienceStaffId: b.jess.id, staffName: 'Jess' });
    expect(await runDueInsights(db, b.options)).toMatchObject({ businesses: 0 });
    // An hour later it runs again; nothing changed, so nothing is written.
    b.clock.set(new Date(Date.parse(NOW) + 61 * MINUTE).toISOString());
    expect(await runInsightsFor(db, b.tenantId, b.options)).toEqual({
      outcome: 'ran',
      created: 0,
      updated: 0,
      expired: 0,
      snoozed: 0,
      risks: { written: 0, removed: 0 },
    });
  });

  it('updates the gap after a booking change, on the next pass', async () => {
    const b = await newBusiness();
    await runInsightsFor(db, b.tenantId, b.options);
    expect((await gapOn(b, '2026-11-03'))?.payload).toMatchObject({ openMinutes: 480 });

    const booking = await createBooking(
      db,
      b.owner,
      {
        clientId: b.maria.id,
        serviceId: b.service.id,
        staffMemberId: b.jess.id,
        startsAt: '2026-11-03T15:00:00.000Z',
      },
      { clock: b.clock },
    );
    b.clock.set(new Date(Date.parse(NOW) + MINUTE).toISOString());
    expect(await runDueInsights(db, b.options)).toMatchObject({ businesses: 1, updated: 1 });
    expect((await gapOn(b, '2026-11-03'))?.payload).toMatchObject({
      gapCount: 2,
      openMinutes: 420,
    });

    await changeBooking(db, b.owner, booking.id, { status: 'cancelled' }, { clock: b.clock });
    b.clock.set(new Date(Date.parse(NOW) + 2 * MINUTE).toISOString());
    await runDueInsights(db, b.options);
    expect((await gapOn(b, '2026-11-03'))?.payload).toMatchObject({ openMinutes: 480 });
  });

  it('runs again after new working hours or time off, which open or close gaps', async () => {
    const b = await newBusiness();
    await runInsightsFor(db, b.tenantId, b.options);
    await replaceWorkingHours(db, b.owner, b.jess.id, {
      intervals: [{ weekday: 2, start: '09:00', end: '17:00' }],
    });
    expect(await runDueInsights(db, b.options)).toMatchObject({ businesses: 1, expired: 4 });
    expect((await feed(b)).map((item) => item.day)).toEqual(['2026-11-03']);
    await addTimeOff(db, b.owner, b.jess.id, {
      startsAt: '2026-11-03T14:00:00.000Z',
      endsAt: '2026-11-03T22:00:00.000Z',
    });
    expect(await runDueInsights(db, b.options)).toMatchObject({ businesses: 1, expired: 1 });
    expect(await feed(b)).toEqual([]);
  });

  it('honours "Pause suggestions" and a kind turned off', async () => {
    const b = await newBusiness();
    await runInsightsFor(db, b.tenantId, b.options);
    const before = (await feed(b)).length;
    await withTenant(db, b.tenantId, async (tx) =>
      writeFeedSettings(tx, { ...(await readFeedSettings(tx)), suggestionsPaused: true }),
    );
    expect(await runInsightsFor(db, b.tenantId, b.options)).toEqual({
      outcome: 'paused',
      risks: { written: 0, removed: 0 },
    });
    expect(await feed(b)).toHaveLength(before);
    // Turning it back on (through the service) asks for a run at once.
    await changeFeedSettings(db, b.owner, { suggestionsPaused: false });
    expect(await runDueInsights(db, b.options)).toMatchObject({ businesses: 1 });

    await withTenant(db, b.tenantId, (tx) =>
      writeFeedSettings(tx, {
        suggestionsPaused: false,
        disabledKinds: ['schedule_gaps'],
        answeredKinds: [],
      }),
    );
    expect(await runInsightsFor(db, b.tenantId, b.options)).toMatchObject({
      outcome: 'ran',
      expired: before,
    });
    expect(await feed(b)).toEqual([]);
  });

  it('shows Jess her gaps through her own login, and only hers', async () => {
    const b = await newBusiness();
    const ben = await createStaffMember(db, b.owner, {
      displayName: 'Ben',
      userId: null,
      serviceIds: [b.service.id],
    });
    await replaceWorkingHours(db, b.owner, ben.id, {
      intervals: [{ weekday: 1, start: '09:00', end: '17:00' }],
    });
    await runInsightsFor(db, b.tenantId, b.options);
    const seen = await withMember(db, { tenantId: b.tenantId, userId: b.staffUser }, (tx) =>
      listOpenFeedItems(tx, new Date(NOW), 200),
    );
    expect(seen.length).toBe(5);
    expect(new Set(seen.map((item) => item.audienceStaffId))).toEqual(new Set([b.jess.id]));
    expect((await feed(b)).some((item) => item.audienceStaffId === ben.id)).toBe(true);
  });
});

// Visit risk (S77, ADR-0071; AC-X-195, AC-X-198): every confirmed visit in the next 14 days
// gets a band and reasons; a second run writes nothing; staff never read them.
describe('visit risk in the insights pass', () => {
  const visit = async (b: Business, startsAt: string): Promise<Booking> =>
    createBooking(
      db,
      b.owner,
      { clientId: b.maria.id, serviceId: b.service.id, staffMemberId: b.jess.id, startsAt },
      { clock: b.clock },
    );
  const risksOf = (b: Business, ids: readonly string[]) =>
    withTenant(db, b.tenantId, (tx) =>
      listVisitRisks(
        tx,
        ids.map((id) => BookingIdSchema.parse(id)),
      ),
    );

  it('scores every confirmed visit in the next 14 days, once', async () => {
    const b = await newBusiness();
    const tomorrow = await visit(b, '2026-11-03T15:00:00.000Z');
    const nextWeek = await visit(b, '2026-11-10T15:00:00.000Z');
    const beyond = await visit(b, '2026-11-17T15:00:00.000Z');
    const first = await runInsightsFor(db, b.tenantId, b.options);
    expect(first).toMatchObject({ outcome: 'ran', risks: { written: 2, removed: 0 } });

    const stored = await risksOf(b, [tomorrow.id, nextWeek.id, beyond.id]);
    expect(stored.map((risk) => risk.bookingId).sort()).toEqual([tomorrow.id, nextWeek.id].sort());
    // Maria's first visit; nobody asked her to confirm yet, so that scores nothing (S78).
    expect(stored.find((risk) => risk.bookingId === tomorrow.id)).toMatchObject({
      band: 'low',
      points: 1,
      reasons: [{ signal: 'first_visit', points: 1 }],
    });
    // Asked and not answered the day before: 2 points, medium (AC-X-201).
    await withTenant(db, b.tenantId, (tx) =>
      markBookingConfirmAsked(tx, BookingIdSchema.parse(tomorrow.id), b.clock.now()),
    );
    b.clock.set(new Date(Date.parse(NOW) + MINUTE).toISOString());
    await runInsightsFor(db, b.tenantId, b.options);
    expect((await risksOf(b, [tomorrow.id]))[0]).toMatchObject({
      band: 'medium',
      points: 2,
      reasons: [
        { signal: 'first_visit', points: 1 },
        { signal: 'not_confirmed', points: 1 },
      ],
    });

    // The same book an hour later: nothing written.
    b.clock.set(new Date(Date.parse(NOW) + 62 * MINUTE).toISOString());
    expect(await runInsightsFor(db, b.tenantId, b.options)).toMatchObject({
      risks: { written: 0, removed: 0 },
    });
  });

  it('drops a cancelled visit; the client’s late cancel is a miss, the business’s isn’t (AC-X-200)', async () => {
    const b = await newBusiness();
    const soon = await visit(b, '2026-11-02T16:00:00.000Z');
    const later = await visit(b, '2026-11-09T15:00:00.000Z');
    await runInsightsFor(db, b.tenantId, b.options);
    // The owner cancels 3 hours before it starts: inside the notice, but the business's.
    b.clock.set('2026-11-02T13:00:00.000Z');
    await changeBooking(db, b.owner, soon.id, { status: 'cancelled' }, { clock: b.clock });
    b.clock.set('2026-11-02T17:00:00.000Z');
    expect(await runInsightsFor(db, b.tenantId, b.options)).toMatchObject({
      risks: { written: 1, removed: 1 },
    });
    const [risk] = await risksOf(b, [soon.id, later.id]);
    expect(risk?.bookingId).toBe(later.id);
    expect(risk?.reasons.map((reason) => reason.signal)).not.toContain('missed_before');

    // Had the client cancelled it (by their link), it is a miss: (1 + 5 × 0.1) / (1 + 5) = 0.25.
    await withTenant(db, b.tenantId, (tx) =>
      // The id is a parsed UUID, so it can stand in the statement.
      tx.execute(
        `UPDATE bookings SET cancelled_by = 'client' WHERE id = '${BookingIdSchema.parse(soon.id)}'`,
      ),
    );
    b.clock.set('2026-11-02T18:01:00.000Z');
    await runInsightsFor(db, b.tenantId, b.options);
    const [again] = await risksOf(b, [later.id]);
    expect(again?.reasons[0]).toEqual({ signal: 'missed_before', points: 2, misses: 1, visits: 1 });
  });

  it('keeps risk current while suggestions are paused', async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenantId, async (tx) =>
      writeFeedSettings(tx, { ...(await readFeedSettings(tx)), suggestionsPaused: true }),
    );
    await visit(b, '2026-11-04T15:00:00.000Z');
    expect(await runInsightsFor(db, b.tenantId, b.options)).toEqual({
      outcome: 'paused',
      risks: { written: 1, removed: 0 },
    });
  });

  it('staff read no visit risk, even of their own visits (AC-X-198)', async () => {
    const b = await newBusiness();
    const own = await visit(b, '2026-11-03T15:00:00.000Z');
    await runInsightsFor(db, b.tenantId, b.options);
    const seen = await withMember(db, { tenantId: b.tenantId, userId: b.staffUser }, (tx) =>
      listVisitRisks(tx, [BookingIdSchema.parse(own.id)]),
    );
    expect(seen).toEqual([]);
    expect(await risksOf(b, [own.id])).toHaveLength(1);
  });
});
