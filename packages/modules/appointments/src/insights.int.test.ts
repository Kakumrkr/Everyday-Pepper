import {
  TenantIdSchema,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, type Actor } from '@pepper/core';
import {
  addMembership,
  listOpenFeedItems,
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
    expect(await runInsightsFor(db, b.tenantId, b.options)).toEqual({ outcome: 'paused' });
    expect(await feed(b)).toHaveLength(before);

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
