import {
  ClientIdSchema,
  ServiceIdSchema,
  TenantIdSchema,
  type ImportBatchId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { createBusiness, ForbiddenError, listClients, ManualClock, type Actor } from '@pepper/core';
import {
  addMembership,
  insertClient,
  insertService,
  insertWaitlistEntry,
  listAuditEntries,
  listDueImportBatches,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ImportMappingInvalidError,
  ImportNotFoundError,
  ImportNotReadyError,
  ImportNotStagedError,
  ImportNotUndoableError,
} from '../errors.js';
import { ImportFileError } from '../parse.js';
import { fixture } from '../test-support.js';
import { insertUser, startTestDatabase, type TestDatabase } from '../int-support.js';
import {
  commitImport,
  discardImport,
  getImport,
  IMPORT_MAX_ATTEMPTS,
  IMPORT_RUN_CHUNK,
  listImports,
  remapImport,
  runImport,
  stageImport,
  tidyImports,
  undoImport,
} from './imports.js';

// Client import against real Postgres (S48, ADR-0049): staging writes no client, a commit is
// run by the worker's job, a re-import creates no duplicates, undo takes the import back, and
// only owners and managers of the business reach any of it (AC-W1-3, AC-W1-17…19).

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

const START = new Date('2026-11-03T15:00:00Z');

async function newBusiness() {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade',
    slug: `imports-${String(slugs)}`,
    timeZone: 'America/Chicago',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff'): Actor => ({
    context: { tenantId, userId, role },
  });
  const member = async (role: 'manager' | 'staff') => {
    const userId = await insertUser(db, role);
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId, role }));
    return actor(userId, role);
  };
  return { tenantId, owner: actor(ownerId, 'owner'), member, clock: new ManualClock(START) };
}

async function clientsOf(tenantId: TenantId) {
  return withTenant(
    db,
    tenantId,
    async (tx) =>
      (
        await tx.execute<{
          name: string;
          email: string | null;
          phone: string | null;
          source: string;
        }>(`SELECT name, email, phone, source FROM clients ORDER BY name`)
      ).rows,
  );
}

/** Stages, commits and runs a file with its suggested mapping. */
async function importFile(business: Awaited<ReturnType<typeof newBusiness>>, bytes: Uint8Array) {
  const { batch } = await stageImport(db, business.owner, bytes);
  await commitImport(db, business.owner, batch.id, business.clock);
  expect(
    await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock),
  ).toBe('done');
  return (await getImport(db, business.owner, batch.id)).batch;
}

describe('staging (AC-W1-17, AC-W1-18)', () => {
  it('previews a tool’s export without writing a client', async () => {
    const business = await newBusiness();
    const preview = await stageImport(db, business.owner, fixture('square.csv'));
    expect(preview.batch).toMatchObject({
      status: 'staged',
      format: 'csv',
      preset: 'square',
      problems: [],
      counts: { rows: 4, create: 4, merge: 0, unchanged: 0, invalid: 0, skipped: 0 },
      committedAt: null,
    });
    expect(preview.rows.map((row) => [row.row, row.name, row.outcome])).toEqual([
      [2, 'Marcus Bell', 'create'],
      [3, 'Dana Ortiz', 'create'],
      [4, 'Tyrell Grant', 'create'],
      [5, 'Ana Silva', 'create'],
    ]);
    expect(await clientsOf(business.tenantId)).toEqual([]);
  });

  it('shows invalid and skipped rows first, with their reasons', async () => {
    const business = await newBusiness();
    const { batch, rows } = await stageImport(db, business.owner, fixture('messy.csv'));
    expect(batch.counts).toMatchObject({ rows: 6, create: 2, invalid: 3, skipped: 1 });
    expect(rows.map((row) => [row.row, row.outcome, row.reasons.map((r) => r.code)])).toEqual([
      [2, 'invalid', ['email_invalid']],
      [3, 'invalid', ['no_name']],
      [4, 'invalid', ['phone_invalid']],
      [7, 'skipped', ['duplicate_in_file']],
      [5, 'create', []],
      [6, 'create', []],
    ]);
  });

  it('previews against the business’s clients: matches merge or stay unchanged', async () => {
    const business = await newBusiness();
    await withTenant(db, business.tenantId, async (tx) => {
      await insertClient(tx, {
        name: 'Marcus Bell',
        email: 'marcus.bell@example.com',
        phone: null,
        source: 'team',
      });
      await insertClient(tx, {
        name: 'Dana Ortiz',
        email: 'dana.ortiz@example.com',
        phone: '+15550100102',
        source: 'team',
      });
    });
    const { batch, rows } = await stageImport(db, business.owner, fixture('square.csv'));
    expect(batch.counts).toMatchObject({ create: 2, merge: 1, unchanged: 1 });
    expect(rows.find((row) => row.row === 2)).toMatchObject({ outcome: 'merge' });
    expect(rows.find((row) => row.row === 3)).toMatchObject({ outcome: 'unchanged' });
  });

  it('refuses a file it can’t read, before writing anything', async () => {
    const business = await newBusiness();
    await expect(stageImport(db, business.owner, Buffer.from('[{"a":'))).rejects.toBeInstanceOf(
      ImportFileError,
    );
    expect(await listImports(db, business.owner)).toEqual([]);
  });

  it('follows a new mapping, and names a missing name column as a problem', async () => {
    const business = await newBusiness();
    const file = Buffer.from('Who,Contact\nAna Silva,ana@example.com\nBen Adler,ben@example.com\n');
    const staged = await stageImport(db, business.owner, file);
    expect(staged.batch.columns.map((c) => [c.column, c.field, c.by])).toEqual([
      ['Who', null, null],
      ['Contact', 'email', 'values'],
    ]);
    expect(staged.batch.problems).toEqual(['Choose the column with the client’s name.']);
    expect(staged.batch.counts).toMatchObject({ invalid: 2 });
    await expect(commitImport(db, business.owner, staged.batch.id, business.clock)).rejects.toThrow(
      new ImportNotReadyError('Choose the column with the client’s name.'),
    );

    const remapped = await remapImport(db, business.owner, staged.batch.id, {
      columns: [{ column: 'Who', field: 'name' }],
    });
    expect(remapped.batch.columns.map((c) => [c.column, c.field, c.by])).toEqual([
      ['Who', 'name', 'owner'],
      ['Contact', null, null],
    ]);
    expect(remapped.batch.problems).toEqual([]);
    expect(remapped.batch.counts).toMatchObject({ create: 2, invalid: 0 });
    await expect(
      remapImport(db, business.owner, staged.batch.id, {
        columns: [{ column: 'Nope', field: 'name' }],
      }),
    ).rejects.toBeInstanceOf(ImportMappingInvalidError);
  });

  it('discards a staged import, and never a committed one', async () => {
    const business = await newBusiness();
    const { batch } = await stageImport(db, business.owner, fixture('booksy.csv'));
    await discardImport(db, business.owner, batch.id);
    await expect(getImport(db, business.owner, batch.id)).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
    const second = await stageImport(db, business.owner, fixture('booksy.csv'));
    await commitImport(db, business.owner, second.batch.id, business.clock);
    await expect(discardImport(db, business.owner, second.batch.id)).rejects.toBeInstanceOf(
      ImportNotStagedError,
    );
  });
});

describe('running (AC-W1-3)', () => {
  it.each([
    ['square.csv', 4],
    ['booksy.csv', 3],
    ['vagaro.csv', 3],
    ['glossgenius.csv', 3],
    ['fresha.csv', 3],
    ['generic.csv', 3],
    ['own-app.json', 3],
    ['own-app.jsonl', 3],
  ])('imports %s, and importing it again creates no duplicates', async (name, count) => {
    const business = await newBusiness();
    const first = await importFile(business, fixture(name));
    expect(first).toMatchObject({ status: 'done', counts: { create: count, invalid: 0 } });
    const clients = await clientsOf(business.tenantId);
    expect(clients).toHaveLength(count);
    expect(clients.every((client) => client.source === 'import')).toBe(true);

    const again = await stageImport(db, business.owner, fixture(name));
    expect(again.batch.counts).toMatchObject({ create: 0, unchanged: count });
    await expect(commitImport(db, business.owner, again.batch.id, business.clock)).rejects.toThrow(
      ImportNotReadyError,
    );
    expect(await clientsOf(business.tenantId)).toHaveLength(count);
  });

  it('commits through the queue: due once, claimed once, audited with counts only', async () => {
    const business = await newBusiness();
    const { batch } = await stageImport(db, business.owner, fixture('square.csv'));
    expect(await dueBatches()).not.toContain(batch.id);
    const committed = await commitImport(db, business.owner, batch.id, business.clock);
    expect(committed).toMatchObject({ status: 'queued', committedAt: START.toISOString() });
    await expect(commitImport(db, business.owner, batch.id, business.clock)).rejects.toBeInstanceOf(
      ImportNotStagedError,
    );
    expect(await dueBatches()).toContain(batch.id);

    const job = { batchId: batch.id, tenantId: business.tenantId };
    expect(await runImport(db, job, business.clock)).toBe('done');
    expect(await runImport(db, job, business.clock)).toBe('not_due');
    expect(await dueBatches()).not.toContain(batch.id);
    const done = (await getImport(db, business.owner, batch.id)).batch;
    expect(done).toMatchObject({
      status: 'done',
      finishedAt: START.toISOString(),
      undoUntil: '2026-11-10T15:00:00.000Z',
      counts: { rows: 4, create: 4 },
    });

    const audit = await withTenant(db, business.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 10 }),
    );
    const imports = audit.filter((entry) => entry.entity.type === 'client_import');
    expect(imports.map((entry) => [entry.action, entry.after])).toEqual([
      [
        'client_import.finished',
        {
          create: 4,
          merge: 0,
          unchanged: 0,
          invalid: 0,
          skipped: 0,
          conflict: 0,
          clients: 4,
          past: 0,
          upcoming: 0,
          status: 'done',
        },
      ],
      ['client_import.committed', { rows: 4 }],
    ]);
    expect(JSON.stringify(audit)).not.toContain('example.com');
  });

  it('plans again at run time: a client added since the preview is merged, not duplicated', async () => {
    const business = await newBusiness();
    const { batch } = await stageImport(db, business.owner, fixture('booksy.csv'));
    await withTenant(db, business.tenantId, (tx) =>
      insertClient(tx, {
        name: 'Jasmine Reed',
        email: 'jasmine.reed@example.com',
        phone: null,
        source: 'booking_page',
      }),
    );
    await commitImport(db, business.owner, batch.id, business.clock);
    await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock);
    const done = (await getImport(db, business.owner, batch.id)).batch;
    expect(done.counts).toMatchObject({ create: 2, merge: 1 });
    const jasmine = (await clientsOf(business.tenantId)).filter((c) => c.name === 'Jasmine Reed');
    expect(jasmine).toEqual([
      {
        name: 'Jasmine Reed',
        email: 'jasmine.reed@example.com',
        phone: '+15550100201',
        source: 'booking_page',
      },
    ]);
  });

  it('runs a large file in chunks and continues after a run cut short', async () => {
    const business = await newBusiness();
    const total = IMPORT_RUN_CHUNK * 2 + 10;
    const lines = Array.from(
      { length: total },
      (_, i) => `Client ${String(i)},c${String(i)}@example.com`,
    );
    const { batch } = await stageImport(
      db,
      business.owner,
      Buffer.from(`Name,Email\n${lines.join('\n')}`),
    );
    await commitImport(db, business.owner, batch.id, business.clock);
    // A run that applied one chunk and died: its rows stay applied, the lease runs out.
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(
        `UPDATE import_batches SET status = 'running', attempts = 1 WHERE id = '${batch.id}'`,
      ),
    );
    expect(
      await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock),
    ).toBe('done');
    expect(await clientsOf(business.tenantId)).toHaveLength(total);
    expect((await getImport(db, business.owner, batch.id)).batch.counts).toMatchObject({
      create: total,
    });
  });

  it('skips a duplicate whose first row was in an earlier chunk, as the preview did', async () => {
    const business = await newBusiness();
    const lines = Array.from(
      { length: IMPORT_RUN_CHUNK + 5 },
      (_, i) => `Client ${String(i)},c${String(i)}@example.com,`,
    );
    // The last row repeats the first client, with a phone the preview won't import.
    lines.push('Client 0,c0@example.com,5550100999');
    const { batch } = await stageImport(
      db,
      business.owner,
      Buffer.from(`Name,Email,Phone\n${lines.join('\n')}`),
    );
    expect(batch.counts).toMatchObject({ create: IMPORT_RUN_CHUNK + 5, skipped: 1 });
    await commitImport(db, business.owner, batch.id, business.clock);
    await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock);
    const done = await getImport(db, business.owner, batch.id);
    expect(done.batch.counts).toMatchObject({ create: IMPORT_RUN_CHUNK + 5, merge: 0, skipped: 1 });
    expect(done.rows[0]).toMatchObject({
      outcome: 'skipped',
      reasons: [
        {
          code: 'duplicate_in_file',
          message: `Row ${String(IMPORT_RUN_CHUNK + 7)}: the same client as row 2, so it’s skipped.`,
        },
      ],
    });
    const phones = await withTenant(
      db,
      business.tenantId,
      async (tx) =>
        (await tx.execute(`SELECT count(*)::int AS n FROM clients WHERE phone IS NOT NULL`)).rows,
    );
    expect(phones).toEqual([{ n: 0 }]);
  });

  it('marks a batch failed after its attempts, keeping it undoable', async () => {
    const business = await newBusiness();
    const { batch } = await stageImport(db, business.owner, fixture('vagaro.csv'));
    await commitImport(db, business.owner, batch.id, business.clock);
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(
        `UPDATE import_batches SET attempts = ${String(IMPORT_MAX_ATTEMPTS)} WHERE id = '${batch.id}'`,
      ),
    );
    expect(
      await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock),
    ).toBe('failed');
    const failed = (await getImport(db, business.owner, batch.id)).batch;
    // Nothing was written: its counts say so, not the preview's.
    expect(failed).toMatchObject({
      status: 'failed',
      undoUntil: '2026-11-10T15:00:00.000Z',
      counts: { rows: 3, create: 0, merge: 0 },
    });
    expect((await undoImport(db, business.owner, batch.id, business.clock)).status).toBe('undone');
  });
});

describe('undo (AC-W1-19)', () => {
  it('removes created clients, clears what it filled, keeps clients booked since', async () => {
    const business = await newBusiness();
    await withTenant(db, business.tenantId, (tx) =>
      insertClient(tx, {
        name: 'Marcus Bell',
        email: 'marcus.bell@example.com',
        phone: null,
        source: 'team',
      }),
    );
    const batch = await importFile(business, fixture('square.csv'));
    expect(batch.counts).toMatchObject({ create: 3, merge: 1 });
    // Ana Silva joins the waitlist after the import: she stays.
    await withTenant(db, business.tenantId, async (tx) => {
      const service = await insertService(tx, {
        name: 'Cut',
        category: null,
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: null,
        priceToCents: null,
        active: true,
      });
      const [ana] = (
        await tx.execute<{ id: string }>(`SELECT id FROM clients WHERE name = 'Ana Silva'`)
      ).rows;
      await insertWaitlistEntry(tx, {
        clientId: ClientIdSchema.parse(ana?.id),
        serviceId: ServiceIdSchema.parse(service.id),
        staffMemberId: null,
        windows: [{ date: '2026-11-20', start: '15:00', end: '18:00' }],
        expiresAt: new Date('2026-11-20T22:00:00Z'),
        createdBy: business.owner.context.userId,
      });
    });

    business.clock.advanceBy(6 * 24 * 60 * 60_000);
    const undone = await undoImport(db, business.owner, batch.id, business.clock);
    expect(undone).toMatchObject({ status: 'undone', undo: { deleted: 2, restored: 1, kept: 1 } });
    expect(await clientsOf(business.tenantId)).toEqual([
      { name: 'Ana Silva', email: 'ana.silva@example.org', phone: null, source: 'import' },
      { name: 'Marcus Bell', email: 'marcus.bell@example.com', phone: null, source: 'team' },
    ]);
    // Its rows' client details are cleared (D-5).
    const rows = await withTenant(
      db,
      business.tenantId,
      async (tx) =>
        (
          await tx.execute(
            `SELECT count(*)::int AS n FROM import_rows WHERE batch_id = '${batch.id}' AND (cells IS NOT NULL OR email IS NOT NULL)`,
          )
        ).rows,
    );
    expect(rows).toEqual([{ n: 0 }]);
    await expect(undoImport(db, business.owner, batch.id, business.clock)).rejects.toThrow(
      new ImportNotUndoableError('It’s already undone.'),
    );
    // Importing it again works as a first import (the undone one is forgotten).
    const again = await stageImport(db, business.owner, fixture('square.csv'));
    expect(again.batch.counts).toMatchObject({ create: 2, merge: 1, unchanged: 1 });
  });

  it('leaves alone a field changed since the import', async () => {
    const business = await newBusiness();
    await withTenant(db, business.tenantId, (tx) =>
      insertClient(tx, {
        name: 'Jasmine Reed',
        email: 'jasmine.reed@example.com',
        phone: null,
        source: 'team',
      }),
    );
    const batch = await importFile(business, fixture('booksy.csv'));
    expect(batch.counts).toMatchObject({ create: 2, merge: 1 });
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(`UPDATE clients SET phone = '+15550109999' WHERE name = 'Jasmine Reed'`),
    );
    const undone = await undoImport(db, business.owner, batch.id, business.clock);
    // The phone stays (changed since); the birthday and tag it added go (S49), so Jasmine counts.
    expect(undone.undo).toEqual({ deleted: 2, restored: 1, kept: 0, bookings: 0, bookingsKept: 0 });
    expect(await clientsOf(business.tenantId)).toEqual([
      {
        name: 'Jasmine Reed',
        email: 'jasmine.reed@example.com',
        phone: '+15550109999',
        source: 'team',
      },
    ]);
  });

  it('clears both fields one row filled, and keeps a created client edited since', async () => {
    const business = await newBusiness();
    // Found by an identical row of an earlier import, with neither email nor phone yet.
    const first = await importFile(business, Buffer.from('Name\nAna Silva\nBen Adler\n'));
    expect(first.counts).toMatchObject({ create: 2 });
    const filled = await importFile(
      business,
      Buffer.from('Name,Email,Phone\nAna Silva,ana@example.com,5550100001\n'),
    );
    // Ana is not matched by name alone: a new client (the preview said so).
    expect(filled.counts).toMatchObject({ create: 1 });
    await undoImport(db, business.owner, filled.id, business.clock);

    // The same export layout twice (its external ids are its own): Cy first without contact.
    const byId = await importFile(business, Buffer.from('Id,Name,Email,Phone\nX1,Cy Okafor,,\n'));
    expect(byId.counts).toMatchObject({ create: 1 });
    const both = await importFile(
      business,
      Buffer.from('Id,Name,Email,Phone\nX1,Cy Okafor,cy@example.com,5550100002\n'),
    );
    expect(both.counts).toMatchObject({ merge: 1 });
    const undone = await undoImport(db, business.owner, both.id, business.clock);
    expect(undone.undo).toEqual({ deleted: 0, restored: 1, kept: 0, bookings: 0, bookingsKept: 0 });
    expect((await clientsOf(business.tenantId)).find((c) => c.name === 'Cy Okafor')).toEqual({
      name: 'Cy Okafor',
      email: null,
      phone: null,
      source: 'import',
    });

    // Ben is edited after the first import: its undo keeps him.
    await withTenant(db, business.tenantId, (tx) =>
      tx.execute(`UPDATE clients SET name = 'Ben Adler Jr' WHERE name = 'Ben Adler'`),
    );
    expect((await undoImport(db, business.owner, first.id, business.clock)).undo).toEqual({
      deleted: 1,
      restored: 0,
      kept: 1,
      bookings: 0,
      bookingsKept: 0,
    });
    expect((await clientsOf(business.tenantId)).map((c) => c.name)).toEqual([
      'Ben Adler Jr',
      'Cy Okafor',
    ]);
  });

  it('refuses an unfinished import, and one past its 7 days', async () => {
    const business = await newBusiness();
    const { batch } = await stageImport(db, business.owner, fixture('fresha.csv'));
    await expect(undoImport(db, business.owner, batch.id, business.clock)).rejects.toThrow(
      new ImportNotUndoableError('It hasn’t finished yet.'),
    );
    await commitImport(db, business.owner, batch.id, business.clock);
    await runImport(db, { batchId: batch.id, tenantId: business.tenantId }, business.clock);
    business.clock.advanceBy(7 * 24 * 60 * 60_000 + 1);
    await expect(undoImport(db, business.owner, batch.id, business.clock)).rejects.toBeInstanceOf(
      ImportNotUndoableError,
    );
    expect(await clientsOf(business.tenantId)).toHaveLength(3);
  });
});

describe('tidying (D-5)', () => {
  it('discards stale staged imports and clears finished ones after their undo window', async () => {
    const business = await newBusiness();
    const staged = await stageImport(db, business.owner, fixture('booksy.csv'));
    const done = await importFile(business, fixture('vagaro.csv'));
    const later = new ManualClock(new Date(START.getTime() + 8 * 24 * 60 * 60_000));
    await tidyImports(db, later, 500);
    await expect(getImport(db, business.owner, staged.batch.id)).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
    const rows = await withTenant(
      db,
      business.tenantId,
      async (tx) =>
        (
          await tx.execute<{
            cells: unknown;
            email: unknown;
            row_hash: string;
            client_id: string | null;
          }>(
            `SELECT cells, email, row_hash, client_id FROM import_rows WHERE batch_id = '${done.id}'`,
          )
        ).rows,
    );
    expect(rows).toHaveLength(3);
    expect(
      rows.every((row) => row.cells === null && row.email === null && row.client_id !== null),
    ).toBe(true);
    // A re-import still finds them by the kept identity.
    const again = await stageImport(db, business.owner, fixture('vagaro.csv'));
    expect(again.batch.counts).toMatchObject({ create: 0, unchanged: 3 });
  });
});

describe('who may import', () => {
  it('lets a manager import, and refuses staff before reading the file', async () => {
    const business = await newBusiness();
    const manager = await business.member('manager');
    const staff = await business.member('staff');
    const { batch } = await stageImport(db, manager, fixture('booksy.csv'));
    await expect(stageImport(db, staff, fixture('booksy.csv'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(getImport(db, staff, batch.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listImports(db, staff)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(undoImport(db, staff, batch.id, business.clock)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('never shows or changes another business’s import', async () => {
    const mine = await newBusiness();
    const theirs = await newBusiness();
    const { batch } = await stageImport(db, theirs.owner, fixture('booksy.csv'));
    const id: ImportBatchId = batch.id;
    await expect(getImport(db, mine.owner, id)).rejects.toBeInstanceOf(ImportNotFoundError);
    await expect(commitImport(db, mine.owner, id, mine.clock)).rejects.toBeInstanceOf(
      ImportNotFoundError,
    );
    await expect(
      remapImport(db, mine.owner, id, { columns: [{ column: 'Email', field: null }] }),
    ).rejects.toBeInstanceOf(ImportNotFoundError);
    await expect(discardImport(db, mine.owner, id)).rejects.toBeInstanceOf(ImportNotFoundError);
    // A job naming the wrong business finds nothing to run.
    await commitImport(db, theirs.owner, id, theirs.clock);
    expect(await runImport(db, { batchId: id, tenantId: mine.tenantId }, mine.clock)).toBe(
      'not_due',
    );
    expect(await listImports(db, mine.owner)).toEqual([]);
  });
});

async function dueBatches() {
  return (await listDueImportBatches(db, new Date(START.getTime() + 60_000), 500)).map(
    (b) => b.batchId,
  );
}

describe('tags and birthdays (S49, AC-W1-25, AC-W1-26)', () => {
  it('brings them with the clients, shows them in the preview, and lists the import’s clients', async () => {
    const business = await newBusiness();
    const staged = await stageImport(db, business.owner, fixture('booksy.csv'));
    expect(staged.rows.find((row) => row.name === 'Lena Park')).toMatchObject({
      tags: ['VIP', 'Lashes'],
      birthday: null,
      visit: null,
    });
    expect(staged.rows.find((row) => row.name === 'Jasmine Reed')?.birthday).toEqual({
      month: 3,
      day: 14,
      year: 1995,
    });
    await commitImport(db, business.owner, staged.batch.id, business.clock);
    await runImport(db, { batchId: staged.batch.id, tenantId: business.tenantId }, business.clock);
    const listed = await listClients(db, business.owner, { import: staged.batch.id });
    expect(listed.map((client) => [client.name, client.tags, client.birthday])).toEqual([
      ['Jasmine Reed', ['VIP'], { month: 3, day: 14, year: 1995 }],
      ['Kofi Mensah', [], null],
      ['Lena Park', ['VIP', 'Lashes'], null],
    ]);
    // Another import's filter lists none of them.
    const other = await stageImport(db, business.owner, fixture('generic.csv'));
    expect(await listClients(db, business.owner, { import: other.batch.id })).toEqual([]);
  });
});

describe('a repeat row on a re-import (S49 CI, fast-check seed 1909035259)', () => {
  it('finds it again by its identity when its contact has become ambiguous', async () => {
    const business = await newBusiness();
    const csv = (rows: string[][]) =>
      Buffer.from(['Name,Email,Phone,Id', ...rows.map((r) => r.join(','))].join('\n'));
    const first = csv([
      ['Cy', 'a@example.com', '5550100002', ''],
      ['Ana', 'a@example.com', '5550100002', '1'],
    ]);
    const second = csv([
      ['Cy', '', '', '1'],
      ['Cy', 'b@example.com', '5550100002', ''],
      ['Ana', 'b@example.com', '', ''],
    ]);
    await importFile(business, first);
    await importFile(business, second);
    // Both files again: nothing new (a repeat row's id and identity point at its client).
    for (const file of [first, second]) {
      expect((await stageImport(db, business.owner, file)).batch.counts.create).toBe(0);
    }
    expect((await clientsOf(business.tenantId)).map((c) => c.name)).toEqual(['Ana', 'Cy']);
  });
});
