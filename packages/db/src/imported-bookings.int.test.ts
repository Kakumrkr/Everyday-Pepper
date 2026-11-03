import {
  ImportBatchIdSchema,
  TenantIdSchema,
  type ImportBatchId,
  type TenantId,
} from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { BookingOverlapError } from './errors.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient, listClients } from './repositories/clients.js';
import {
  findImportDefaultStaffMemberId,
  insertImportedBookings,
  listClientBookingStarts,
  undoImportedBookings,
  type NewImportedBooking,
} from './repositories/imported-bookings.js';
import {
  fillClientContact,
  insertImportBatch,
  insertImportedClients,
  markImportRowsApplied,
  replaceImportRows,
  undoImportBatchRows,
} from './repositories/imports.js';
import { addMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { bookingOccupancy, bookings, clients } from './schema.js';
import { withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Imported bookings, tags and birthdays against real Postgres (S49, ADR-0050, migration 0059):
// imported history occupies no time, upcoming imports still can't overlap, an undo removes only
// what nobody changed, and a client's tags and birthday are filled, never overwritten.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase({ maxConnections: 6 });
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

interface Business {
  tenant: TenantId;
  service: string;
  staff: string;
  client: string;
  batch: ImportBatchId;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Juniper',
    slug: `juniper-imported-${String(slugs)}`,
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
    const staff = await insertStaffMember(tx, {
      displayName: 'Jess',
      color: '#2a7230',
      active: true,
      membershipId: null,
    });
    const client = await insertClient(tx, {
      name: 'Maria Lopez',
      email: 'maria@example.test',
      phone: null,
      source: 'team',
    });
    const batch = await newBatch(tx);
    return { tenant, service: service.id, staff: staff.id, client: client.id, batch };
  });
}

async function newBatch(tx: TenantTx): Promise<ImportBatchId> {
  const row = await insertImportBatch(tx, {
    createdByUserId: null,
    kind: 'visits',
    format: 'csv',
    preset: null,
    system: 'file:test',
    columns: [],
    problems: [],
    counts: {},
  });
  return ImportBatchIdSchema.parse(row.id);
}

function visit(b: Business, startsAt: string, status: NewImportedBooking['status']) {
  const start = new Date(startsAt);
  return {
    id: newId(),
    clientId: b.client,
    serviceId: b.service,
    staffMemberId: b.staff,
    startsAt: start,
    endsAt: new Date(start.getTime() + 60 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: 5000,
    status,
    createdBy: null,
  } satisfies NewImportedBooking;
}

describe('imported bookings (AC-W1-23, AC-W1-24)', () => {
  it('stores overlapping history whole, occupying no time', async () => {
    const b = await newBusiness();
    const first = visit(b, '2026-03-02T15:00:00Z', 'completed');
    const second = visit(b, '2026-03-02T15:30:00Z', 'no_show');
    await withTenant(db, b.tenant, (tx) => insertImportedBookings(tx, b.batch, [first, second]));
    await withTenant(db, b.tenant, async (tx) => {
      const rows = await tx.select().from(bookings).where(eq(bookings.importBatchId, b.batch));
      expect(rows.map((row) => [row.status, row.source])).toEqual([
        ['completed', 'import'],
        ['no_show', 'import'],
      ]);
      expect(await tx.select().from(bookingOccupancy)).toEqual([]);
    });
  });

  it('refuses an upcoming import that overlaps another booking', async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenant, (tx) =>
      insertBooking(tx, {
        clientId: b.client as never,
        serviceId: b.service as never,
        staffMemberId: b.staff as never,
        startsAt: new Date('2027-01-05T15:00:00Z'),
        endsAt: new Date('2027-01-05T16:00:00Z'),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        source: 'team',
        overridden: false,
        idempotencyKey: null,
        createdBy: null,
      }),
    );
    await expect(
      withTenant(db, b.tenant, (tx) =>
        insertImportedBookings(tx, b.batch, [visit(b, '2027-01-05T15:30:00Z', 'confirmed')]),
      ),
    ).rejects.toBeInstanceOf(BookingOverlapError);
    // The same time as history (past, completed) is fine.
    await withTenant(db, b.tenant, (tx) =>
      insertImportedBookings(tx, b.batch, [visit(b, '2027-01-05T15:30:00Z', 'completed')]),
    );
  });

  it('ties an imported booking to its batch, and only an imported one', async () => {
    const b = await newBusiness();
    const error = await withTenant(db, b.tenant, (tx) =>
      tx.execute(sql`
        INSERT INTO bookings (id, client_id, service_id, staff_member_id, starts_at, ends_at,
          buffer_before_minutes, buffer_after_minutes, source)
        VALUES (${newId()}, ${b.client}, ${b.service}, ${b.staff}, '2026-01-01T10:00:00Z',
          '2026-01-01T11:00:00Z', 0, 0, 'import')`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514');
  });

  it("lists clients' visit starts, leaving cancelled ones out", async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenant, (tx) =>
      insertImportedBookings(tx, b.batch, [visit(b, '2026-03-02T15:00:00Z', 'completed')]),
    );
    const starts = await withTenant(db, b.tenant, (tx) =>
      listClientBookingStarts(
        tx,
        [b.client],
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-12-31T00:00:00Z'),
      ),
    );
    expect(starts).toEqual([{ clientId: b.client, startsAt: new Date('2026-03-02T15:00:00Z') }]);
  });

  it('undoes the bookings nobody changed, keeping a moved one', async () => {
    const b = await newBusiness();
    const kept = visit(b, '2027-02-01T15:00:00Z', 'confirmed');
    const gone = visit(b, '2026-02-01T15:00:00Z', 'completed');
    await withTenant(db, b.tenant, (tx) => insertImportedBookings(tx, b.batch, [kept, gone]));
    await withTenant(db, b.tenant, (tx) =>
      tx
        .update(bookings)
        .set({
          startsAt: new Date('2027-02-01T17:00:00Z'),
          endsAt: new Date('2027-02-01T18:00:00Z'),
        })
        .where(eq(bookings.id, kept.id)),
    );
    const undo = await withTenant(db, b.tenant, (tx) => undoImportedBookings(tx, b.batch));
    expect(undo).toEqual({ deleted: 1, kept: 1 });
    const left = await withTenant(db, b.tenant, (tx) =>
      tx.select({ id: bookings.id }).from(bookings),
    );
    expect(left).toEqual([{ id: kept.id }]);
  });

  it("sends visits with no staff member to the importer's own, else the owner's", async () => {
    const b = await newBusiness();
    const owner = await insertUser(db);
    const manager = await insertUser(db);
    const ids = await withTenant(db, b.tenant, async (tx) => {
      const ownerMembership = await addMembership(tx, { userId: owner, role: 'owner' });
      const managerMembership = await addMembership(tx, { userId: manager, role: 'manager' });
      const staff = (displayName: string, membershipId: string) =>
        insertStaffMember(tx, { displayName, color: '#2a7230', active: true, membershipId });
      return {
        owner: (await staff('Dre', ownerMembership.id)).id,
        manager: (await staff('Kai', managerMembership.id)).id,
      };
    });
    const pick = (userId: string | null) =>
      withTenant(db, b.tenant, (tx) => findImportDefaultStaffMemberId(tx, userId));
    expect(await pick(manager)).toBe(ids.manager);
    expect(await pick(owner)).toBe(ids.owner);
    expect(await pick(null)).toBe(ids.owner);
  });
});

describe('tags and birthdays (AC-W1-25)', () => {
  it('refuses a day the month lacks and more than 20 tags', async () => {
    const b = await newBusiness();
    const write = (values: Record<string, unknown>) =>
      withTenant(db, b.tenant, (tx) =>
        tx.update(clients).set(values).where(eq(clients.id, b.client)),
      ).catch((e: unknown) => e);
    expect(sqlState(await write({ birthdayMonth: 4, birthdayDay: 31 }))).toBe('23514');
    expect(sqlState(await write({ birthdayMonth: 4 }))).toBe('23514');
    expect(
      sqlState(await write({ tags: Array.from({ length: 21 }, (_, i) => `t${String(i)}`) })),
    ).toBe('23514');
    expect(
      sqlState(await write({ birthdayMonth: 2, birthdayDay: 29, tags: ['VIP'] })),
    ).toBeUndefined();
  });

  it('fills a birthday only when empty and adds only missing tags, and an undo takes them back', async () => {
    const b = await newBusiness();
    const fills = await withTenant(db, b.tenant, async (tx) => {
      await tx
        .update(clients)
        .set({ tags: ['VIP'] })
        .where(eq(clients.id, b.client));
      const filled = await fillClientContact(tx, b.client, {
        birthday: { month: 6, day: 14, year: null },
        tags: ['vip', 'Color'],
      });
      // A second fill finds the birthday set and both tags there.
      expect(
        await fillClientContact(tx, b.client, {
          birthday: { month: 1, day: 1, year: 1990 },
          tags: ['Color'],
        }),
      ).toEqual({});
      await replaceImportRows(tx, b.batch, [
        {
          position: 0,
          row: 2,
          cells: [],
          name: 'Maria Lopez',
          email: null,
          phone: null,
          externalId: null,
          rowHash: 'h',
          outcome: 'merge',
          reasons: [],
          clientId: b.client,
          fills: {},
        },
      ]);
      await markImportRowsApplied(
        tx,
        b.batch,
        [
          {
            position: 0,
            outcome: 'merge',
            reasons: [],
            clientId: b.client,
            fills: filled,
            createdClient: false,
            bookingId: null,
            visit: null,
          },
        ],
        new Date(),
      );
      return filled;
    });
    expect(fills).toEqual({ birthday: { month: 6, day: 14, year: null }, tags: ['Color'] });
    const undo = await withTenant(db, b.tenant, (tx) => undoImportBatchRows(tx, b.batch));
    expect(undo).toEqual({ deleted: 0, restored: 1, kept: 0 });
    const [client] = await withTenant(db, b.tenant, (tx) =>
      tx.select().from(clients).where(eq(clients.id, b.client)),
    );
    expect(client).toMatchObject({ tags: ['VIP'], birthdayMonth: null, birthdayDay: null });
  });

  it('creates imported clients with tags and a birthday, listed by their import', async () => {
    const b = await newBusiness();
    const id = newId();
    await withTenant(db, b.tenant, async (tx) => {
      await insertImportedClients(tx, [
        {
          id,
          name: 'Ana Ruiz',
          email: null,
          phone: null,
          tags: ['Regular'],
          birthday: { month: 12, day: 3, year: 1988 },
        },
      ]);
      await replaceImportRows(tx, b.batch, [
        {
          position: 0,
          row: 2,
          cells: [],
          name: 'Ana Ruiz',
          email: null,
          phone: null,
          externalId: null,
          rowHash: 'h2',
          outcome: 'create',
          reasons: [],
          clientId: null,
          fills: {},
        },
      ]);
      await markImportRowsApplied(
        tx,
        b.batch,
        [
          {
            position: 0,
            outcome: 'create',
            reasons: [],
            clientId: id,
            fills: {},
            createdClient: true,
            bookingId: null,
            visit: null,
          },
        ],
        new Date(),
      );
    });
    const listed = await withTenant(db, b.tenant, (tx) =>
      listClients(tx, { limit: 50, importBatchId: b.batch }),
    );
    expect(listed.map((c) => [c.name, c.tags, c.birthdayMonth, c.birthdayYear])).toEqual([
      ['Ana Ruiz', ['Regular'], 12, 1988],
    ]);
    const all = await withTenant(db, b.tenant, (tx) => listClients(tx, { limit: 50 }));
    expect(all).toHaveLength(2);
  });
});
