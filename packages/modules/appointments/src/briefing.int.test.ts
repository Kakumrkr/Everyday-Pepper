import { TenantIdSchema, type Service, type StaffMember, type TenantId } from '@pepper/contracts';
import {
  changeFeedSettings,
  createBusiness,
  createClient,
  getFeed,
  ManualClock,
  savePushDevice,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  listDueOutboxMessages,
  readMorningDueAt,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBooking } from './services/bookings.js';
import { runBriefingFor, runDueBriefings, type BriefingOptions } from './services/briefing.js';
import { replaceWorkingHours } from './services/hours.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The daily briefing against real Postgres (S38a, ADR-0042, playbook F-4): once a morning at
// the business's local hour (its own setting over the template's), the business's briefing
// for owners and managers, each staff member's own day for them, the morning pushes, and the
// briefing shown while suggestions are paused.

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

// Monday 2 November 2026 in New York (EST, UTC−5): 6:59, 7:00 and 9:00 local.
const BEFORE = '2026-11-02T11:59:00.000Z';
const SEVEN = '2026-11-02T12:00:00.000Z';
const NINE = '2026-11-02T14:00:00.000Z';
const KEY = Buffer.alloc(32, 7);

interface Business {
  tenantId: TenantId;
  owner: Actor;
  staff: Actor;
  service: Service;
  jess: StaffMember;
  clock: ManualClock;
  options: BriefingOptions;
}

/** Jess (a staff login) works Mon–Fri 09:00–17:00, with two haircuts booked on Monday. */
async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-briefing-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const staffUser = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffUser, role: 'staff' }));
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const staff: Actor = { context: { tenantId, userId: staffUser, role: 'staff' } };
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffUser,
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
  const clock = new ManualClock('2026-11-01T12:00:00.000Z');
  const maria = await createClient(db, owner, { name: 'Maria Lopez', email: 'maria@example.test' });
  for (const startsAt of ['2026-11-02T15:00:00.000Z', '2026-11-02T19:00:00.000Z']) {
    await createBooking(
      db,
      owner,
      { serviceId: service.id, staffMemberId: jess.id, clientId: maria.id, startsAt },
      { clock },
    );
  }
  return {
    tenantId,
    owner,
    staff,
    service,
    jess,
    clock,
    options: {
      clock,
      insightsOf: () => ({ enabled: ['schedule_gaps', 'rebooking_due'], minGapMinutes: 60 }),
      morningHourOf: () => 7,
      pushKey: KEY,
    },
  };
}

describe('the daily briefing', () => {
  it('waits for the local morning hour, briefs once, and again the next morning', async () => {
    const b = await newBusiness();
    b.clock.set(BEFORE);
    expect(await runBriefingFor(db, b.tenantId, b.options)).toEqual({ outcome: 'waiting' });
    expect(await withTenant(db, b.tenantId, (tx) => readMorningDueAt(tx, 'briefing'))).toEqual(
      new Date(SEVEN),
    );

    b.clock.set(SEVEN);
    expect(await runBriefingFor(db, b.tenantId, b.options)).toMatchObject({
      outcome: 'ran',
      written: 2,
    });
    expect(await runBriefingFor(db, b.tenantId, b.options)).toEqual({ outcome: 'not_due' });
    // Tomorrow 7:00 local.
    expect(await withTenant(db, b.tenantId, (tx) => readMorningDueAt(tx, 'briefing'))).toEqual(
      new Date('2026-11-03T12:00:00.000Z'),
    );

    const owners = await getFeed(db, b.owner, { clock: b.clock, morningHourOf: () => 7 });
    expect(owners.templateMorningHour).toBe(7);
    expect(owners.briefing).toMatchObject({
      kind: 'daily_briefing',
      day: '2026-11-02',
      subjects: { staffMemberId: null },
      payload: {
        scope: 'business',
        bookingCount: 2,
        firstStartsAt: '2026-11-02T15:00:00.000Z',
        // 9–10 and 11–14 open, then 15–17.
        gapCount: 3,
        openMinutes: 360,
        rebookingDueCount: 0,
      },
    });
    // Never among the suggestions.
    expect(owners.suggestions.map((item) => item.kind)).not.toContain('daily_briefing');

    const jess = await getFeed(db, b.staff, { clock: b.clock });
    expect(jess.briefing).toMatchObject({
      subjects: { staffMemberId: b.jess.id },
      names: { staff: 'Jess' },
      payload: { scope: 'staff', bookingCount: 2, needsOkCount: null },
    });

    b.clock.set('2026-11-03T12:00:00.000Z');
    expect(await runBriefingFor(db, b.tenantId, b.options)).toMatchObject({ outcome: 'ran' });
    const tuesday = await getFeed(db, b.owner, { clock: b.clock });
    expect(tuesday.briefing).toMatchObject({ day: '2026-11-03', payload: { bookingCount: 0 } });
  });

  it("follows the business's own morning hour over the template's", async () => {
    const b = await newBusiness();
    await changeFeedSettings(db, b.owner, { morningHour: 9 });
    b.clock.set(SEVEN);
    expect(await runBriefingFor(db, b.tenantId, b.options)).toEqual({ outcome: 'waiting' });
    b.clock.set(NINE);
    expect(await runBriefingFor(db, b.tenantId, b.options)).toMatchObject({ outcome: 'ran' });
    expect((await getFeed(db, b.owner, { clock: b.clock })).settings.morningHour).toBe(9);
  });

  it('still briefs while suggestions are paused: it only informs', async () => {
    const b = await newBusiness();
    await changeFeedSettings(db, b.owner, { suggestionsPaused: true });
    b.clock.set(SEVEN);
    await runBriefingFor(db, b.tenantId, b.options);
    const feed = await getFeed(db, b.owner, { clock: b.clock });
    expect(feed.suggestions).toEqual([]);
    expect(feed.briefing?.payload).toMatchObject({ bookingCount: 2 });
  });

  it('pushes the business to the owner and her own day to Jess, once per device', async () => {
    const b = await newBusiness();
    const device = (n: number) => ({
      endpoint: `https://fcm.googleapis.com/fcm/send/briefing-${String(slugs)}-${String(n)}`,
      keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
    });
    await savePushDevice(db, b.owner, device(1));
    await savePushDevice(db, b.staff, device(2));
    b.clock.set(SEVEN);
    const result = await runBriefingFor(db, b.tenantId, b.options);
    expect(result).toMatchObject({ outcome: 'ran', pushes: 2 });
    const queued = (await listDueOutboxMessages(db, new Date(SEVEN), 1000)).filter(
      (message) => message.tenantId === b.tenantId,
    );
    expect(queued).toHaveLength(2);
    // Without a push key (no VAPID keys): written, nothing pushed.
    const quiet = await newBusiness();
    quiet.clock.set(SEVEN);
    expect(
      await runBriefingFor(db, quiet.tenantId, { ...quiet.options, pushKey: null }),
    ).toMatchObject({ outcome: 'ran', written: 2, pushes: 0 });
  });

  it('runs every business whose morning has come in one pass', async () => {
    const [a, b] = [await newBusiness(), await newBusiness()];
    a.clock.set(SEVEN);
    const result = await runDueBriefings(db, { ...a.options, clock: a.clock });
    expect(result.businesses).toBeGreaterThanOrEqual(2);
    expect((await getFeed(db, b.owner, { clock: a.clock })).briefing).not.toBeNull();
  });
});
