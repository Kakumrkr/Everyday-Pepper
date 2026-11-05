import { readFileSync } from 'node:fs';
import {
  importVisitBook,
  createBooking,
  listWinBackIn,
  createService,
  createStaffMember,
} from '@pepper/appointments';
import {
  TenantIdSchema,
  UserIdSchema,
  type ImportBatchId,
  type ImportPreview,
  type TenantId,
} from '@pepper/contracts';
import { createBusiness, createClient, listClients, ManualClock, type Actor } from '@pepper/core';
import {
  createDatabase,
  newId,
  prepareDatabase,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import {
  commitImport,
  runImport,
  stageImport,
  undoImport,
  type ImportOptions,
} from '@pepper/imports';
import { postgresUrlAs, startPostgres, type TestService } from '@pepper/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A visits file end to end, as the api stages it and the worker runs it, with the appointments
// module's `VisitBook` (S49, ADR-0050, AC-W1-22…26): clients found or created, past visits and
// upcoming appointments written with no email, conflicts listed, a re-import adding nothing,
// an undo taking it back, and the gate: 1,000 clients and 5,000 visits in under 2 minutes.

let postgres: TestService;
let handle: DatabaseHandle;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  postgres = await startPostgres();
  const url = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, url);
  handle = createDatabase({ url, maxConnections: 4, connectionTimeoutMs: 30_000 });
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
  await postgres.stop();
});

const NOW = '2026-11-03T15:00:00.000Z';
const fixture = (name: string) =>
  readFileSync(
    new URL(`../../../../packages/modules/imports/src/fixtures/${name}`, import.meta.url),
  );

interface Business {
  tenantId: TenantId;
  owner: Actor;
  clock: ManualClock;
  options: ImportOptions;
}

async function newBusiness(staff: string[] = ['Dre']): Promise<Business> {
  slugs += 1;
  const ownerId = UserIdSchema.parse(newId());
  await db
    .insert(users)
    .values({ id: ownerId, name: 'Ana', email: `owner-${ownerId}@example.test` });
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-visits-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 45 });
  for (const displayName of staff) {
    await createStaffMember(db, owner, { displayName, serviceIds: [service.id] });
  }
  const clock = new ManualClock(NOW);
  return { tenantId, owner, clock, options: { clock, visits: importVisitBook } };
}

async function run(b: Business, preview: ImportPreview) {
  await commitImport(db, b.owner, preview.batch.id, b.clock);
  expect(
    await runImport(db, { batchId: preview.batch.id, tenantId: b.tenantId }, b.clock, b.options),
  ).toBe('done');
}

const count = (b: Business, query: string) =>
  withTenant(db, b.tenantId, async (tx) => {
    const { rows } = await tx.execute<{ n: number }>(query);
    return rows[0]?.n ?? 0;
  });

describe('a visits file (AC-W1-22…25)', () => {
  it('stages clients, past visits and upcoming ones, naming what it brings', async () => {
    const b = await newBusiness();
    const preview = await stageImport(db, b.owner, fixture('visits.csv'), b.options);
    expect(preview.batch).toMatchObject({ kind: 'visits', problems: [] });
    expect(preview.batch.counts).toMatchObject({
      rows: 5,
      create: 5,
      clients: 2,
      past: 4,
      upcoming: 1,
      conflict: 0,
    });
    expect(preview.batch.notices).toEqual([
      '“Fade Deluxe” isn’t one of your services: 2 visits bring it in as a hidden service of 50 minutes.',
      '“Jo” isn’t on your team: 1 visit goes to Dre.',
      '1 visit doesn’t say who it was with, so it goes to Dre.',
    ]);
    expect(preview.rows[0]?.visit).toEqual({
      startsAt: '2026-04-02T14:00:00.000Z',
      durationMinutes: 45,
      service: 'Haircut',
      staff: 'Dre',
      status: 'completed',
      bookingId: null,
    });
    // Nothing is written before the commit.
    expect(await count(b, 'SELECT count(*)::int AS n FROM bookings')).toBe(0);
  });

  it('writes them with no email or reminder, finds them again, and undoes them', async () => {
    const b = await newBusiness();
    const preview = await stageImport(db, b.owner, fixture('visits.csv'), b.options);
    await run(b, preview);
    expect(await count(b, "SELECT count(*)::int AS n FROM bookings WHERE source = 'import'")).toBe(
      5,
    );
    expect(
      await count(b, "SELECT count(*)::int AS n FROM bookings WHERE status = 'confirmed'"),
    ).toBe(1);
    expect(await count(b, 'SELECT count(*)::int AS n FROM outbox_messages')).toBe(0);
    expect(await count(b, 'SELECT count(*)::int AS n FROM booking_reminders')).toBe(0);
    expect(await count(b, 'SELECT count(*)::int AS n FROM services WHERE NOT active')).toBe(1);
    // The insights run once for the import.
    expect(await count(b, 'SELECT count(*)::int AS n FROM insight_requests')).toBeGreaterThan(0);

    const listed = await listClients(db, b.owner, { import: preview.batch.id });
    expect(listed.map((client) => client.name)).toEqual(['Ana Ruiz', 'Ben Cole']);

    // The same file again: every visit is already in Pepper.
    const again = await stageImport(db, b.owner, fixture('visits.csv'), b.options);
    expect(again.batch.counts).toMatchObject({ create: 0, unchanged: 5, clients: 0 });

    const requests = await count(b, 'SELECT count(*)::int AS n FROM insight_requests');
    const undone = await undoImport(db, b.owner, preview.batch.id, b.clock, b.options);
    // The insights run again without the history that went.
    expect(await count(b, 'SELECT count(*)::int AS n FROM insight_requests')).toBe(requests + 1);
    expect(undone.undo).toEqual({
      deleted: 2,
      restored: 0,
      kept: 0,
      bookings: 5,
      bookingsKept: 0,
    });
    expect(await count(b, 'SELECT count(*)::int AS n FROM bookings')).toBe(0);
    expect(await count(b, 'SELECT count(*)::int AS n FROM clients')).toBe(0);
  });

  it('lists an upcoming time the calendar has taken as a conflict (AC-W1-24)', async () => {
    const b = await newBusiness();
    const dre = (
      await withTenant(db, b.tenantId, (tx) =>
        tx.execute<{ id: string; service: string }>(
          "SELECT s.id, v.id AS service FROM staff_members s, services v WHERE s.display_name = 'Dre' AND v.name = 'Haircut'",
        ),
      )
    ).rows[0];
    const someone = await createClient(db, b.owner, { name: 'Walk In' });
    // 8 January 2027, 10:15 in New York: inside Ana's 10:00–10:45 haircut.
    await createBooking(db, b.owner, {
      clientId: someone.id,
      serviceId: dre?.service as never,
      staffMemberId: dre?.id as never,
      startsAt: '2027-01-08T15:15:00.000Z',
      override: true,
    });
    const preview = await stageImport(db, b.owner, fixture('visits.csv'), b.options);
    expect(preview.batch.counts).toMatchObject({ create: 4, conflict: 1, upcoming: 0, past: 4 });
    expect(preview.rows[0]).toMatchObject({
      row: 6,
      outcome: 'conflict',
      reasons: [
        {
          code: 'conflict',
          message:
            'Row 6: Dre already has a booking at Jan 8, 10:15 AM, so this one is left out. Book it again from the calendar if it still stands.',
        },
      ],
    });
    await run(b, preview);
    expect(await count(b, "SELECT count(*)::int AS n FROM bookings WHERE source = 'import'")).toBe(
      4,
    );
  });

  it('meets the clients a client import brought by their ids in the same tool', async () => {
    const b = await newBusiness(['Dre', 'Kai']);
    await run(b, await stageImport(db, b.owner, fixture('square.csv'), b.options));
    const preview = await stageImport(db, b.owner, fixture('square-appointments.csv'), b.options);
    expect(preview.batch).toMatchObject({ kind: 'visits', preset: 'square' });
    expect(preview.batch.counts).toMatchObject({
      rows: 5,
      clients: 0,
      create: 4,
      skipped: 1,
      past: 3,
      upcoming: 1,
    });
    await run(b, preview);
    expect(await count(b, "SELECT count(*)::int AS n FROM bookings WHERE status = 'no_show'")).toBe(
      1,
    );
  });
});

describe('after the code review (S49)', () => {
  const file = (...rows: string[]) =>
    Buffer.from(['Date,Time,Client,Email,Service,Staff,Length,Tags', ...rows].join('\n'));

  it('makes a hidden service as long as most of its visits, as the preview said', async () => {
    const b = await newBusiness();
    const preview = await stageImport(
      db,
      b.owner,
      file(
        '2026-01-05,10:00,Ana,ana@example.test,Fade,Dre,45,',
        '2026-02-05,10:00,Ana,ana@example.test,Fade,Dre,45,',
        '2026-03-05,10:00,Ana,ana@example.test,Fade,Dre,90,',
      ),
      b.options,
    );
    expect(preview.batch.notices[0]).toContain('hidden service of 45 minutes');
    await run(b, preview);
    expect(await count(b, "SELECT duration_minutes AS n FROM services WHERE name = 'Fade'")).toBe(
      45,
    );
  });

  it('leaves a visit nobody on the team can take as one to fix, not as imported', async () => {
    const b = await newBusiness();
    const preview = await stageImport(
      db,
      b.owner,
      file('2026-01-05,10:00,Ana,ana@example.test,Haircut,,45,'),
      b.options,
    );
    expect(preview.batch.problems).toEqual([]);
    await withTenant(db, b.tenantId, (tx) => tx.execute('UPDATE staff_members SET active = false'));
    await run(b, preview);
    const done = await withTenant(db, b.tenantId, async (tx) => {
      const { rows } = await tx.execute<{ counts: { create: number; invalid: number } }>(
        `SELECT counts FROM import_batches WHERE id = '${preview.batch.id}'`,
      );
      return rows[0]?.counts;
    });
    expect(done).toMatchObject({ create: 0, invalid: 1, past: 0 });
    expect(await count(b, 'SELECT count(*)::int AS n FROM bookings')).toBe(0);
  });

  it('commits a re-import that only fills client details', async () => {
    const b = await newBusiness();
    const first = '2026-01-05,10:00,Ana,ana@example.test,Haircut,Dre,45,';
    await run(b, await stageImport(db, b.owner, file(first), b.options));
    const again = await stageImport(db, b.owner, file(`${first}VIP`), b.options);
    expect(again.batch.counts).toMatchObject({ create: 0, unchanged: 1 });
    await run(b, again);
    expect(await count(b, "SELECT count(*)::int AS n FROM clients WHERE tags = '{VIP}'")).toBe(1);
  });
});

/**
 * The gate's file (AC-W1-26): 1,000 clients with 5 visits each. Clients 0–499 have an upcoming
 * visit (3 staff, an hour each, no two at once), the rest only history; clients 0–19 have one
 * cancelled visit; one upcoming visit meets a booking already in the calendar.
 */
function bigFile(): Buffer {
  const lines = ['Date,Time,Client,Email,Phone,Service,Staff,Length,Price,Status'];
  const staff = ['Dre', 'Kai', 'Jo'];
  for (let j = 0; j < 1000; j += 1) {
    const name = `Client ${String(j).padStart(4, '0')}`;
    const email = `client${String(j)}@example.test`;
    const phone = `555${String(1_000_000 + j).slice(-7)}`;
    for (let v = 0; v < 5; v += 1) {
      let date: Date;
      let time: string;
      let status = 'done';
      if (v === 4 && j < 500) {
        // Upcoming: slot j → staff j % 3, then 8 one-hour slots a day from 9 AM.
        const slot = Math.floor(j / 3);
        date = new Date(Date.UTC(2026, 11, 1 + Math.floor(slot / 8)));
        time = `${String(9 + (slot % 8))}:00`;
        status = 'booked';
      } else {
        date = new Date(Date.UTC(2025, 0, 1 + ((j * 5 + v) % 600)));
        time = `${String(9 + ((j + v) % 8))}:30`;
        if (v === 0 && j < 20) status = 'Cancelled';
      }
      const day = date.toISOString().slice(0, 10);
      const service = v % 2 === 0 ? 'Haircut' : 'Beard Trim';
      lines.push(
        [day, time, name, email, phone, service, staff[j % 3], '45', '40', status].join(','),
      );
    }
  }
  return Buffer.from(`${lines.join('\n')}\n`);
}

describe('1,000 clients and 5,000 visits (AC-W1-26)', () => {
  it('stages and runs in under 2 minutes with exact counts', { timeout: 300_000 }, async () => {
    const b = await newBusiness(['Dre', 'Kai', 'Jo']);
    // Client 0's upcoming visit is on 1 December 2026, 9 AM with Dre: already taken.
    const dre = (
      await withTenant(db, b.tenantId, (tx) =>
        tx.execute<{ id: string; service: string }>(
          "SELECT s.id, v.id AS service FROM staff_members s, services v WHERE s.display_name = 'Dre' AND v.name = 'Haircut'",
        ),
      )
    ).rows[0];
    const someone = await createClient(db, b.owner, { name: 'Walk In' });
    await createBooking(db, b.owner, {
      clientId: someone.id,
      serviceId: dre?.service as never,
      staffMemberId: dre?.id as never,
      startsAt: '2026-12-01T14:00:00.000Z',
      override: true,
    });
    const file = bigFile();
    const started = performance.now();
    const preview = await stageImport(db, b.owner, file, b.options);
    const staged = performance.now();
    await run(b, preview);
    const finished = performance.now();
    const seconds = (finished - started) / 1000;
    // The timing, for the session log, in the message a slow run fails with.
    const timing = `stage ${((staged - started) / 1000).toFixed(1)} s, run ${((finished - staged) / 1000).toFixed(1)} s`;
    expect(seconds, timing).toBeLessThan(120);

    const expected = {
      rows: 5000,
      clients: 1000,
      create: 4979,
      past: 4480,
      upcoming: 499,
      conflict: 1,
      skipped: 20,
      invalid: 0,
      unchanged: 0,
    };
    expect(preview.batch.counts).toMatchObject(expected);
    const batchId: ImportBatchId = preview.batch.id;
    const done = await withTenant(db, b.tenantId, async (tx) => {
      const { rows } = await tx.execute<{ counts: unknown }>(
        `SELECT counts FROM import_batches WHERE id = '${batchId}'`,
      );
      return rows[0]?.counts;
    });
    expect(done).toMatchObject(expected);
    expect(await count(b, "SELECT count(*)::int AS n FROM clients WHERE source = 'import'")).toBe(
      1000,
    );
    expect(
      await count(
        b,
        "SELECT count(*)::int AS n FROM bookings WHERE source = 'import' AND status = 'completed'",
      ),
    ).toBe(4480);
    expect(
      await count(
        b,
        "SELECT count(*)::int AS n FROM bookings WHERE source = 'import' AND status = 'confirmed'",
      ),
    ).toBe(499);
    expect(await count(b, 'SELECT count(*)::int AS n FROM outbox_messages')).toBe(0);
    // The walk-in booked in Pepper has its reminder; no imported booking has one.
    expect(
      await count(
        b,
        "SELECT count(*)::int AS n FROM booking_reminders r JOIN bookings k ON k.id = r.id WHERE k.source = 'import'",
      ),
    ).toBe(0);
  });
});

describe("after the import: who hasn't been back (S54.2, AC-W4-8)", () => {
  it("counts the overdue regulars and their dollars, the file's own sums", async () => {
    const b = await newBusiness();
    // Ana: haircuts 30 days apart, due Jul 31. Ben: fades 42 days apart, due Oct 26. Cy is due
    // on Nov 19, Di came once, Eve is booked again: none of them is overdue.
    const csv = [
      'Date,Time,Client,Email,Phone,Service,Staff,Length,Price,Status',
      '2026-06-01,10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-0601,Haircut,Dre,45,45,done',
      '2026-07-01,10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-0601,Haircut,Dre,45,45,done',
      '2026-08-03,11:00 AM,Ben Cole,,555-010-0602,Fade Deluxe,Dre,50,55,done',
      '2026-09-14,11:00 AM,Ben Cole,,555-010-0602,Fade Deluxe,Dre,50,55,done',
      '2026-09-20,12:00 PM,Cy Diaz,cy@example.com,555-010-0603,Haircut,Dre,45,45,done',
      '2026-10-20,12:00 PM,Cy Diaz,cy@example.com,555-010-0603,Haircut,Dre,45,45,done',
      '2026-10-01,1:00 PM,Di Fox,di@example.com,555-010-0604,Haircut,Dre,45,45,done',
      '2026-05-01,2:00 PM,Eve Hart,eve@example.com,555-010-0605,Haircut,Dre,45,45,done',
      '2026-06-01,2:00 PM,Eve Hart,eve@example.com,555-010-0605,Haircut,Dre,45,45,done',
      '2099-01-05,2:00 PM,Eve Hart,eve@example.com,555-010-0605,Haircut,Dre,45,45,booked',
    ].join('\n');
    const preview = await stageImport(db, b.owner, Buffer.from(csv), b.options);
    expect(preview.batch).toMatchObject({ kind: 'visits', problems: [] });
    await run(b, preview);
    const answer = await withTenant(db, b.tenantId, (tx) =>
      listWinBackIn(tx, b.owner, { clock: b.clock }),
    );
    // Haircut has no price of its own and Fade Deluxe is a hidden service: the visits' prices.
    expect(answer.clients.map((each) => [each.name, each.valueCents, each.reach])).toEqual([
      ['Ben Cole', 5500, 'no_email'],
      ['Ana Ruiz', 4500, 'email'],
    ]);
    expect(answer).toMatchObject({ count: 2, totalCents: 4500 + 5500 });
  });
});
