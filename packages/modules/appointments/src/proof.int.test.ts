import {
  MINUTES_SAVED,
  StaffMemberIdSchema,
  TenantIdSchema,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  ForbiddenError,
  ManualClock,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  insertBooking,
  insertExecution,
  insertImportBatch,
  insertImportedBookings,
  newId,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readProofIn } from './services/proof.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Proof of value against real Postgres (S55, ADR-0058; AC-W4-10…13): the week card's numbers
// equal the fixture's sums, and the evening wrap names tomorrow's visits at risk. Rows are made
// now, so the week's clock is a minute ahead of the wall clock; the wrap's clock is fixed.

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

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface World {
  tenantId: TenantId;
  ownerId: UserId;
  owner: Actor;
  manager: Actor;
  staff: Actor;
  haircut: Service;
  jess: StaffMember;
}

async function newWorld(): Promise<World> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-proof-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const staffUser = await insertUser(db, 'Jess');
  const managerUser = await insertUser(db, 'Max');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: staffUser, role: 'staff' });
    await addMembership(tx, { userId: managerUser, role: 'manager' });
  });
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const haircut = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    priceFromCents: 4500,
  });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess Park',
    userId: staffUser,
    serviceIds: [haircut.id],
  });
  return {
    tenantId,
    ownerId,
    owner,
    manager: { context: { tenantId, userId: managerUser, role: 'manager' } },
    staff: { context: { tenantId, userId: staffUser, role: 'staff' } },
    haircut,
    jess,
  };
}

let slot = 0;
/** A visit booked now, in the days ahead. */
async function book(
  w: World,
  client: Client,
  source: 'team' | 'ai' | 'booking_page',
  priceFromCents: number | null,
): Promise<void> {
  slot += 1;
  const start = Date.now() + 2 * DAY_MS + slot * HOUR_MS;
  await withTenant(db, w.tenantId, (tx) =>
    insertBooking(tx, {
      clientId: client.id,
      serviceId: w.haircut.id,
      staffMemberId: StaffMemberIdSchema.parse(w.jess.id),
      startsAt: new Date(start),
      endsAt: new Date(start + HOUR_MS),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents,
      priceToCents: null,
      source,
      overridden: false,
      idempotencyKey: null,
      createdBy: null,
      manageTokenHash: null,
    }),
  );
}

/** An action the AI did now, on a client. */
async function did(
  w: World,
  action: 'message.rebooking_nudge' | 'booking.move',
  clientId: string,
): Promise<void> {
  await withTenant(db, w.tenantId, (tx) =>
    insertExecution(tx, {
      proposalId: null,
      action,
      tool: 'test_tool',
      outcome: 'execute',
      idempotencyKey: `proof:${newId()}`,
      entity: { type: 'client', id: clientId },
      before: null,
      after: null,
      undo: null,
      explanation: {
        requestMessageId: null,
        steps: [],
        facts: [],
        alternatives: [],
        untrustedContext: false,
        decision: { outcome: 'execute', reason: 'setting' },
      },
      outboxMessageIds: [],
      onBehalfOf: w.ownerId,
      recordOwner: null,
    }),
  );
}

const soon = () => new ManualClock(new Date(Date.now() + 60_000).toISOString());
const read = (w: World, actor: Actor, clock: ManualClock) =>
  withTenant(db, w.tenantId, (tx) => readProofIn(tx, actor, { clock }));

describe('the week card (AC-W4-10, AC-W4-11)', () => {
  it("equals the fixture's sums: Pepper's visits, a regular back with dollars, the minutes", async () => {
    const w = await newWorld();
    const make = (name: string) => createClient(db, w.owner, { name });
    const [maria, sam, bea, tom] = [
      await make('Maria Lopez'),
      await make('Sam Diaz'),
      await make('Bea Tran'),
      await make('Tom Lee'),
    ];
    await book(w, maria, 'booking_page', 4500);
    await book(w, sam, 'ai', 6000);
    // Bea got a win-back nudge, then the owner booked her in: a regular back.
    await did(w, 'message.rebooking_nudge', bea.id);
    await book(w, bea, 'team', 12_000);
    // The owner's own booking of Tom is not Pepper's.
    await book(w, tom, 'team', 9900);
    await did(w, 'booking.move', tom.id);

    const { week } = await read(w, w.owner, soon());
    expect(week).toMatchObject({
      visitsBooked: 3,
      gapsFilled: 0,
      regularsBack: 1,
      regularsBackCents: 12_000,
      valueCents: 4500 + 6000 + 12_000,
      minutesSaved: 2 * MINUTES_SAVED.booking + MINUTES_SAVED.message + MINUTES_SAVED.action,
    });
    expect(Date.parse(week.to) - Date.parse(week.from)).toBe(7 * DAY_MS);
  });

  it('is zeros for a new business, and managers read it too', async () => {
    const w = await newWorld();
    const { week, evening } = await read(w, w.manager, soon());
    expect(week).toMatchObject({ visitsBooked: 0, valueCents: 0, minutesSaved: 0 });
    // Whether the wrap shows depends on the wall clock's hour in New York; empty if it does.
    expect(evening === null || evening.visitCount === 0).toBe(true);
  });

  it('is refused to staff (the dollars and the names are the business’s)', async () => {
    const w = await newWorld();
    await expect(read(w, w.staff, soon())).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('the evening wrap (AC-W4-12)', () => {
  // Wednesday 4 March 2099, 17:30 in New York (EST, UTC−5); tomorrow is Thursday the 5th.
  const EVENING = '2099-03-04T22:30:00.000Z';
  const tomorrow = (hour: number) => new Date(Date.UTC(2099, 2, 5, hour + 5));

  async function visitTomorrow(w: World, client: Client, hour: number): Promise<void> {
    await withTenant(db, w.tenantId, (tx) =>
      insertBooking(tx, {
        clientId: client.id,
        serviceId: w.haircut.id,
        staffMemberId: StaffMemberIdSchema.parse(w.jess.id),
        startsAt: tomorrow(hour),
        endsAt: new Date(tomorrow(hour).getTime() + HOUR_MS),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: 4500,
        priceToCents: null,
        source: 'team',
        overridden: false,
        idempotencyKey: null,
        createdBy: null,
        manageTokenHash: null,
      }),
    );
  }

  /** Past no-shows, brought in as history. */
  async function noShows(w: World, client: Client, isoDays: readonly string[]): Promise<void> {
    await withTenant(db, w.tenantId, async (tx) => {
      const batch = await insertImportBatch(tx, {
        createdByUserId: null,
        kind: 'visits',
        format: 'csv',
        preset: null,
        system: 'file:test',
        columns: [],
        problems: [],
        counts: {},
      });
      await insertImportedBookings(
        tx,
        batch.id as never,
        isoDays.map((day) => ({
          id: newId(),
          clientId: client.id,
          serviceId: w.haircut.id,
          staffMemberId: w.jess.id,
          startsAt: new Date(`${day}T15:00:00Z`),
          endsAt: new Date(`${day}T16:00:00Z`),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 4500,
          status: 'no_show' as const,
          createdBy: null,
        })),
      );
    });
  }

  it("counts tomorrow from the first visit and names the client who doesn't show", async () => {
    const w = await newWorld();
    const sam = await createClient(db, w.owner, { name: 'Sam Diaz' });
    const maria = await createClient(db, w.owner, { name: 'Maria Lopez' });
    await noShows(w, sam, ['2099-01-10', '2099-02-14']);
    await noShows(w, maria, ['2099-02-20']);
    await visitTomorrow(w, maria, 9);
    await visitTomorrow(w, sam, 11);
    await visitTomorrow(w, maria, 15);

    const { evening } = await read(w, w.owner, new ManualClock(EVENING));
    expect(evening).toMatchObject({
      day: '2099-03-05',
      visitCount: 3,
      firstStartsAt: '2099-03-05T14:00:00.000Z',
      atRiskCount: 1,
      atRisk: [{ clientName: 'Sam Diaz', startsAt: '2099-03-05T16:00:00.000Z', noShowCount: 2 }],
    });
  });

  it('is not there before the evening hour', async () => {
    const w = await newWorld();
    const { evening } = await read(w, w.owner, new ManualClock('2099-03-04T21:59:00.000Z'));
    expect(evening).toBeNull();
  });
});
