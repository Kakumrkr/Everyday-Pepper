import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  BUSINESS_EXPORT_FILES,
  ImportPreviewSchema,
  TenantIdSchema,
  UserIdSchema,
  type ImportPreview,
  type TenantId,
} from '@pepper/contracts';
import { importVisitBook } from '@pepper/appointments';
import { systemClock } from '@pepper/core';
import {
  addMembership,
  listAuditEntries,
  newId,
  prepareDatabase,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
import { runImport } from '@pepper/imports';
import { createLogger, createServiceApp, DATABASE } from '@pepper/runtime';
import {
  postgresUrlAs,
  startPostgres,
  startRedis,
  totpCodeFromUri,
  type TestService,
} from '@pepper/testing';
import type { INestApplication } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// The business export through the api against real Postgres and Redis (S51, ADR-0053,
// AC-W1-37, AC-W1-38): the owner downloads a ZIP; its clients.csv and visits.csv import into
// a new business as the same clients and visits with nothing mapped by hand, and into the same
// business as nothing new; managers and staff are refused; the audit log has counts only.

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let database: DatabaseHandle;
let ipCounter = 0;
let emailCounter = 0;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'warn',
  });
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  app = await createServiceApp(AppModule.forRoot(config), config, {
    logger: createLogger(config, sink),
  });
  await app.init();
  server = app.getHttpServer() as Server;
  database = app.get<DatabaseHandle>(DATABASE);
}, 180_000);

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

function browser() {
  const agent = request.agent(server);
  ipCounter += 1;
  const ip = `198.51.100.${String(ipCounter)}`;
  const send = <T extends request.Test>(test: T): T =>
    test.set('origin', ORIGIN).set('x-forwarded-for', ip);
  return {
    get: (path: string) => send(agent.get(path)),
    post: (path: string, body: object = {}) => send(agent.post(path)).send(body),
    put: (path: string, body: object) => send(agent.put(path)).send(body),
    upload: (bytes: Uint8Array) =>
      send(agent.post('/v1/imports'))
        .set('content-type', 'text/csv')
        .send(Buffer.from(bytes)),
    /** The export, its body kept as bytes. */
    download: () =>
      send(agent.get('/v1/tenant/export'))
        .buffer(true)
        .parse((response, done) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            done(null, Buffer.concat(chunks));
          });
        }),
  };
}
type Browser = ReturnType<typeof browser>;

async function signUp(name: string): Promise<{ browser: Browser; userId: string }> {
  const b = browser();
  emailCounter += 1;
  const email = `${name.split(' ')[0]?.toLowerCase() ?? 'member'}.${String(emailCounter)}@example.test`;
  const response = await b
    .post('/api/auth/sign-up/email', { name, email, password: PASSWORD })
    .expect(200);
  const userId = (response.body as { user: { id: string } }).user.id;
  await database.db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${userId}`);
  await b.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  return { browser: b, userId };
}

async function member(tenantId: TenantId, role: 'manager' | 'staff'): Promise<Browser> {
  const joined = await signUp(role === 'manager' ? 'Mo Manager' : 'Jess Moreno');
  await withTenant(database.db, tenantId, (tx) =>
    addMembership(tx, { userId: UserIdSchema.parse(joined.userId), role }),
  );
  await joined.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return joined.browser;
}

/** An owner with a business, a second factor, a service and Dre to do it. */
async function business() {
  const owner = await signUp('Ana Reyes');
  const created = await owner.browser
    .post('/v1/tenants', {
      name: 'Fade Lab',
      timeZone: 'America/New_York',
      slug: `fade-${newId().slice(-8)}`,
    })
    .expect(201);
  const tenantId = TenantIdSchema.parse((created.body as { id: string }).id);
  const enabled = await owner.browser
    .post('/api/auth/two-factor/enable', { password: PASSWORD })
    .expect(200);
  const { totpURI } = enabled.body as { totpURI: string };
  await owner.browser
    .post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpURI) })
    .expect(200);
  const service = await owner.browser
    .post('/v1/services', { name: 'Haircut', durationMinutes: 45 })
    .expect(201);
  await owner.browser
    .post('/v1/staff', {
      displayName: 'Dre',
      serviceIds: [(service.body as { id: string }).id],
    })
    .expect(201);
  return { tenantId, owner: owner.browser };
}

/** Uploads a file, checks it is recognised as Pepper's, commits and runs it. */
async function importFile(b: { tenantId: TenantId; owner: Browser }, bytes: Uint8Array) {
  const staged: ImportPreview = ImportPreviewSchema.parse(
    (await b.owner.upload(bytes).expect(201)).body,
  );
  expect(staged.batch.preset).toBe('pepper');
  expect(staged.batch.columns.filter((column) => column.field === null)).toEqual([]);
  if (staged.batch.counts.create + staged.batch.counts.merge === 0) return staged.batch;
  await b.owner.post(`/v1/imports/${staged.batch.id}/commit`).expect(202);
  await runImport(database.db, { batchId: staged.batch.id, tenantId: b.tenantId }, systemClock, {
    visits: importVisitBook,
  });
  return ImportPreviewSchema.parse((await b.owner.get(`/v1/imports/${staged.batch.id}`)).body)
    .batch;
}

const VISITS = [
  'Date,Time,Client,Email,Phone,Service,Staff,Length,Price,Status',
  '2026-04-02,10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-0601,Haircut,Dre,45,45,done',
  '2026-05-14,11:00 AM,"Ben ""B"" Cole",,555-010-0602,Fade Deluxe,Dre,50,55,no show',
  '2026-06-30,11:00 AM,Cy,,,Haircut,Dre,45,45,done',
  '2099-01-08,10:00 AM,Ana Ruiz,ana.ruiz@example.com,555-010-0601,Haircut,Dre,45,45,booked',
].join('\n');

interface Exported {
  files: Record<string, string>;
}

async function exported(b: Browser): Promise<Exported> {
  const response = await b.download().expect(200);
  expect(response.headers['content-type']).toBe('application/zip');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-disposition']).toMatch(
    /^attachment; filename="pepper-export-fade-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip"$/,
  );
  const files = Object.fromEntries(
    Object.entries(unzipSync(new Uint8Array(response.body as Buffer))).map(([name, bytes]) => [
      name,
      new TextDecoder().decode(bytes),
    ]),
  );
  return { files };
}

/** What a business's clients and visits are, without ids. */
function shape({ files }: Exported) {
  const clients = (
    JSON.parse(files['clients.json'] ?? '[]') as {
      name: string;
      email: string | null;
      phone: string | null;
      tags: string[];
      birthdayMonth: number | null;
      birthdayDay: number | null;
    }[]
  )
    .map((c) =>
      [c.name, c.email, c.phone, c.tags.join(';'), c.birthdayMonth, c.birthdayDay].join('|'),
    )
    .sort();
  const rows = (files['visits.csv'] ?? '').trim().split('\r\n').slice(1);
  // Date, time, length, service, staff, price, status and client; not the two ids.
  const visits = rows
    .map((row) => {
      const cells = row.split(',');
      return [...cells.slice(1, 8), ...cells.slice(9)].join(',');
    })
    .sort();
  return { clients, visits };
}

describe('the business export (AC-W1-37, AC-W1-38)', () => {
  it('round-trips: a new business gets the same clients and visits, the same one nothing', async () => {
    const a = await business();
    // The seed is any tool's file (not Pepper's), imported with its suggested mapping.
    const seed = ImportPreviewSchema.parse(
      (await a.owner.upload(new TextEncoder().encode(VISITS)).expect(201)).body,
    );
    expect(seed.batch.counts).toMatchObject({ create: 4 });
    await a.owner.post(`/v1/imports/${seed.batch.id}/commit`).expect(202);
    await runImport(database.db, { batchId: seed.batch.id, tenantId: a.tenantId }, systemClock, {
      visits: importVisitBook,
    });
    // And a client with only a name and tags, who has never visited.
    await a.owner.post('/v1/clients', { name: '=Dee Hart', tags: ['vip'] }).expect(201);

    const fromA = await exported(a.owner);
    expect(Object.keys(fromA.files)).toEqual(BUSINESS_EXPORT_FILES.map((file) => file.name));
    const before = shape(fromA);
    expect(before.clients).toHaveLength(4);
    expect(before.visits).toHaveLength(4);

    const b = await business();
    const clients = await importFile(b, new TextEncoder().encode(fromA.files['clients.csv']));
    expect(clients.counts).toMatchObject({ create: 4, invalid: 0, skipped: 0 });
    const visits = await importFile(b, new TextEncoder().encode(fromA.files['visits.csv']));
    // Every visit finds the client clients.csv brought: no client is added twice.
    expect(visits.counts).toMatchObject({ create: 4, clients: 0, conflict: 0, invalid: 0 });
    const after = shape(await exported(b.owner));
    // The formula guard's quote is the one change a spreadsheet-safe file makes.
    expect(after.clients).toEqual(
      before.clients.map((line) => line.replace(/^=Dee Hart/, "'=Dee Hart")),
    );
    expect(after.visits).toEqual(before.visits);

    // Back into the business it came from: nothing new.
    const again = await importFile(a, new TextEncoder().encode(fromA.files['clients.csv']));
    expect(again.counts).toMatchObject({ create: 0, unchanged: 4 });
    const visitsAgain = await importFile(a, new TextEncoder().encode(fromA.files['visits.csv']));
    expect(visitsAgain.counts).toMatchObject({ create: 0, clients: 0 });
    expect(shape(await exported(a.owner))).toEqual(before);
  });

  it('is the owner’s only, and audited with counts', async () => {
    const a = await business();
    await a.owner.post('/v1/clients', { name: 'Maria Lopez', email: 'maria@example.test' });
    const manager = await member(a.tenantId, 'manager');
    const staff = await member(a.tenantId, 'staff');
    expect((await manager.download().expect(403)).body).toBeDefined();
    await staff.download().expect(403);
    const theirs = await exported(a.owner);
    expect(theirs.files['clients.csv']).toContain('Maria Lopez');

    const entries = await withTenant(database.db, a.tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
    const audit = entries.filter((entry) => entry.action === 'business.exported');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      after: { clients: 1, visits: 0, services: 1, staff: expect.any(Number) as number },
    });
    expect(JSON.stringify(audit)).not.toContain('maria');
  });
});
