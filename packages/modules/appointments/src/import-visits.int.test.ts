import { ImportBatchIdSchema, TenantIdSchema, type Client, type TenantId } from '@pepper/contracts';
import { createBusiness, createClient, type Actor } from '@pepper/core';
import { insertImportBatch, newId, withMember, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBooking, listClientBookingsIn } from './services/bookings.js';
import { importVisitBook } from './services/import-visits.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The appointments module's side of a visits import (S49, ADR-0050, AC-W1-23, AC-W1-24)
// against real Postgres: what planning reads, hidden services, and visits written with no
// email, no reminder and no overlap upcoming, read back as any visit.

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

const NOW = new Date('2026-11-03T15:00:00Z');

interface Business {
  tenantId: TenantId;
  owner: Actor;
  serviceId: string;
  jessId: string;
  maria: Client;
  batch: ReturnType<typeof ImportBatchIdSchema.parse>;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-import-visits-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
  });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  const maria = await createClient(db, owner, { name: 'Maria Lopez', email: 'maria@example.test' });
  const batch = await withTenant(db, tenantId, (tx) =>
    insertImportBatch(tx, {
      createdByUserId: ownerId,
      kind: 'visits',
      format: 'csv',
      preset: null,
      system: 'file:test',
      columns: [],
      problems: [],
      counts: {},
    }),
  );
  return {
    tenantId,
    owner,
    serviceId: service.id,
    jessId: jess.id,
    maria,
    batch: ImportBatchIdSchema.parse(batch.id),
  };
}

function visit(b: Business, startsAt: string, status: 'completed' | 'no_show' | 'confirmed') {
  const start = new Date(startsAt);
  return {
    id: newId(),
    clientId: b.maria.id,
    serviceId: b.serviceId,
    staffMemberId: b.jessId,
    startsAt: start,
    endsAt: new Date(start.getTime() + 60 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: 4500,
    status,
    createdBy: null,
  };
}

const count = async (
  tenantId: TenantId,
  table: 'outbox_messages' | 'booking_reminders' | 'insight_requests',
) =>
  withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  });

describe('importVisitBook (ADR-0050)', () => {
  it('gives planning the zone, every service, the active staff and who takes the rest', async () => {
    const b = await newBusiness();
    const context = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.context(tx, b.owner.context.userId),
    );
    expect(context).toMatchObject({
      timeZone: 'America/New_York',
      services: [{ id: b.serviceId, name: 'Haircut', durationMinutes: 60, bufferAfterMinutes: 10 }],
      staff: [{ id: b.jessId, name: 'Jess' }],
      // The owner isn't bookable here: the business's first active staff member.
      defaultStaff: { id: b.jessId, name: 'Jess' },
    });
  });

  it('adds a hidden service once, and finds one by name whatever its case', async () => {
    const b = await newBusiness();
    const added = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.addHiddenServices(tx, [
        { name: 'Fade  Deluxe', durationMinutes: 50 },
        { name: 'haircut', durationMinutes: 30 },
      ]),
    );
    expect(added.map((s) => [s.name, s.durationMinutes])).toEqual([
      ['Fade Deluxe', 50],
      ['Haircut', 60],
    ]);
    const again = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.addHiddenServices(tx, [{ name: 'FADE DELUXE', durationMinutes: 20 }]),
    );
    expect(again[0]?.id).toBe(added[0]?.id);
    const { rows } = await withTenant(db, b.tenantId, (tx) =>
      tx.execute<{ name: string; active: boolean }>(
        'SELECT name, active FROM services ORDER BY name',
      ),
    );
    expect(rows).toEqual([
      { name: 'Fade Deluxe', active: false },
      { name: 'Haircut', active: true },
    ]);
  });

  it('writes history and upcoming visits with no email and no reminder (AC-W1-24)', async () => {
    const b = await newBusiness();
    const past = visit(b, '2026-03-02T15:00:00Z', 'completed');
    // Overlapping history comes in whole.
    const pastOverlap = visit(b, '2026-03-02T15:30:00Z', 'no_show');
    const upcoming = visit(b, '2026-11-10T15:00:00Z', 'confirmed');
    const result = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.writeVisits(tx, b.batch, [past, pastOverlap, upcoming]),
    );
    expect(result).toEqual({ conflicts: [] });
    expect(await count(b.tenantId, 'outbox_messages')).toBe(0);
    expect(await count(b.tenantId, 'booking_reminders')).toBe(0);
    expect(await count(b.tenantId, 'insight_requests')).toBe(0);
    await withTenant(db, b.tenantId, (tx) => importVisitBook.finished(tx));
    expect(await count(b.tenantId, 'insight_requests')).toBe(1);

    // The AI's `find_client_bookings` reads them as any visit (AC-W1-23).
    const seen = await withMember(db, b.owner.context, (tx) =>
      listClientBookingsIn(tx, b.owner, b.maria.id, { now: NOW, upcoming: 5, recent: 5 }),
    );
    expect(seen.upcoming.map((x) => [x.id, x.status, x.source])).toEqual([
      [upcoming.id, 'confirmed', 'import'],
    ]);
    expect(seen.recent.map((x) => x.id)).toEqual([pastOverlap.id, past.id]);
  });

  it('returns an upcoming visit whose time was taken as a conflict, writing the rest', async () => {
    const b = await newBusiness();
    await createBooking(db, b.owner, {
      clientId: b.maria.id,
      serviceId: b.serviceId,
      staffMemberId: b.jessId,
      startsAt: '2026-11-10T15:00:00.000Z',
      override: true,
    });
    const taken = visit(b, '2026-11-10T15:30:00Z', 'confirmed');
    const free = visit(b, '2026-11-11T15:00:00Z', 'confirmed');
    const busy = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.busy(tx, new Date('2026-11-10T00:00:00Z'), new Date('2026-11-12T00:00:00Z')),
    );
    expect(busy).toEqual([
      {
        staffMemberId: b.jessId,
        from: new Date('2026-11-10T15:00:00Z'),
        to: new Date('2026-11-10T16:10:00Z'),
      },
    ]);
    const result = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.writeVisits(tx, b.batch, [taken, free]),
    );
    expect(result).toEqual({ conflicts: [taken.id] });
    const starts = await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.visitStarts(
        tx,
        [b.maria.id],
        new Date('2026-11-01T00:00:00Z'),
        new Date('2026-12-01T00:00:00Z'),
      ),
    );
    expect(starts.map((s) => s.startsAt.toISOString())).toEqual(
      expect.arrayContaining(['2026-11-10T15:00:00.000Z', '2026-11-11T15:00:00.000Z']),
    );
    expect(starts).toHaveLength(2);
  });

  it('undoes the batch’s bookings', async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenantId, (tx) =>
      importVisitBook.writeVisits(tx, b.batch, [visit(b, '2026-03-02T15:00:00Z', 'completed')]),
    );
    expect(await withTenant(db, b.tenantId, (tx) => importVisitBook.undo(tx, b.batch))).toEqual({
      deleted: 1,
      kept: 0,
    });
  });
});
