import {
  StaffMemberIdSchema,
  TenantIdSchema,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deleteClient,
  ForbiddenError,
  ManualClock,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  insertBooking,
  insertService,
  optOutClientEmail,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toService } from './mapping.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { listWinBackIn } from './services/win-back.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// "Haven't been back" against real Postgres (S54.2, ADR-0057; AC-W4-6, AC-W4-8): who is on
// the list, in which order, each one's reach, and the count and sum the post-import line uses.

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

// Monday 2 November 2026, 10:00 in New York (EST).
const NOW = '2026-11-02T15:00:00.000Z';
const DAY_MS = 86_400_000;

interface World {
  tenantId: TenantId;
  owner: Actor;
  staff: Actor;
  haircut: Service;
  color: Service;
  jess: StaffMember;
  clock: ManualClock;
}

async function newWorld(): Promise<World> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-win-back-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const staffUser = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffUser, role: 'staff' }));
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const haircut = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    priceFromCents: 4500,
  });
  // A colour is due back 42 days after it (the template's starting menu sets such intervals).
  const color = toService(
    await withTenant(db, tenantId, (tx) =>
      insertService(
        tx,
        { name: 'Color', durationMinutes: 60, priceFromCents: 12000 },
        { rebookAfterDays: 42 },
      ),
    ),
  );
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess Park',
    userId: staffUser,
    serviceIds: [haircut.id, color.id],
  });
  return {
    tenantId,
    owner,
    staff: { context: { tenantId, userId: staffUser, role: 'staff' } },
    haircut,
    color,
    jess,
    clock: new ManualClock(NOW),
  };
}

let hour = 0;
/** Visits `daysAgo` days before NOW (negative: ahead), each at its own hour. */
async function visits(
  w: World,
  client: Client,
  service: Service,
  daysAgo: readonly number[],
): Promise<void> {
  await withTenant(db, w.tenantId, async (tx) => {
    for (const back of daysAgo) {
      hour = (hour + 1) % 8;
      const start = Date.parse(NOW) - back * DAY_MS + hour * 3_600_000;
      await insertBooking(tx, {
        clientId: client.id,
        serviceId: service.id,
        staffMemberId: StaffMemberIdSchema.parse(w.jess.id),
        startsAt: new Date(start),
        endsAt: new Date(start + 60 * 60_000),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: service.priceFromCents,
        priceToCents: null,
        source: 'team',
        overridden: false,
        idempotencyKey: null,
        createdBy: null,
        manageTokenHash: null,
      });
    }
  });
}

const list = (w: World, actor = w.owner) =>
  withTenant(db, w.tenantId, (tx) => listWinBackIn(tx, actor, { clock: w.clock }));

describe("haven't been back", () => {
  it('lists the clients past their gap, most recently due first, with reach, value and the sum', async () => {
    const w = await newWorld();
    const make = (name: string, email: string | null) =>
      createClient(db, w.owner, { name, ...(email !== null && { email }) });
    const maria = await make('Maria Lopez', 'maria@example.test');
    const ana = await make('Ana Ruiz', 'ana@example.test');
    const sara = await make('Sara Kim', 'sara@example.test');
    const bea = await make('Bea Tran', null);
    const tom = await make('Tom Lee', 'tom@example.test');
    const lea = await make('Lea Fox', 'lea@example.test');
    const zed = await make('Zed Moss', 'zed@example.test');

    // Haircuts every 28 days, last 40 days ago: due 12 days ago.
    await visits(w, maria, w.haircut, [68, 40]);
    // Colour (42 days), last 60 days ago: due 18 days ago.
    await visits(w, ana, w.color, [102, 60]);
    // Unsubscribed, and no email: listed, with why they can't be emailed.
    await visits(w, sara, w.haircut, [100, 72]); // due 44 days ago
    await visits(w, bea, w.haircut, [90, 60]); // due 30 days ago
    // Booked ahead, one visit only, not due yet: not listed.
    await visits(w, tom, w.haircut, [90, 60, -3]);
    await visits(w, lea, w.haircut, [200]);
    await visits(w, zed, w.haircut, [30, 10]); // due in 10 days
    await withTenant(db, w.tenantId, (tx) => optOutClientEmail(tx, sara.id, new Date(NOW)));

    const answer = await list(w);
    expect(answer.clients.map((each) => [each.name, each.daysOverdue, each.reach])).toEqual([
      ['Maria Lopez', 12, 'email'],
      ['Ana Ruiz', 18, 'email'],
      ['Bea Tran', 30, 'no_email'],
      ['Sara Kim', 44, 'opted_out'],
    ]);
    expect(answer.clients[1]).toMatchObject({
      serviceName: 'Color',
      staffName: 'Jess Park',
      valueCents: 12000,
      visits: 2,
      pendingProposalId: null,
      emailedAt: null,
    });
    // The post-import line's numbers: every client listed, and their prices summed.
    expect(answer).toMatchObject({ count: 4, totalCents: 4500 + 12000 + 4500 + 4500 });
    expect(answer.mailingAddressSet).toBe(false);
  });

  it('is empty for a business with no history, and closed to staff', async () => {
    const w = await newWorld();
    expect(await list(w)).toEqual({
      clients: [],
      count: 0,
      totalCents: 0,
      mailingAddressSet: false,
    });
    await expect(list(w, w.staff)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('prices a visit on a service without a price at what the visit cost (imported history)', async () => {
    const w = await newWorld();
    const beard = toService(
      await withTenant(db, w.tenantId, (tx) =>
        insertService(tx, { name: 'Beard trim', durationMinutes: 30, active: false }),
      ),
    );
    const maria = await createClient(db, w.owner, { name: 'Maria Lopez' });
    await visits(w, maria, { ...beard, priceFromCents: 2800 }, [68, 40]);
    expect(await list(w)).toMatchObject({
      count: 1,
      totalCents: 2800,
      clients: [{ serviceName: 'Beard trim', valueCents: 2800 }],
    });
  });

  it("leaves out a deleted client's visits", async () => {
    const w = await newWorld();
    const maria = await createClient(db, w.owner, { name: 'Maria Lopez' });
    await visits(w, maria, w.haircut, [68, 40]);
    expect((await list(w)).count).toBe(1);
    await deleteClient(db, w.owner, maria.id, { clock: w.clock });
    expect((await list(w)).count).toBe(0);
  });
});
