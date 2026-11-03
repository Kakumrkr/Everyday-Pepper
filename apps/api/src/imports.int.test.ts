import 'reflect-metadata';
import type { Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import {
  ImportBatchSchema,
  ImportPreviewSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@pepper/contracts';
import { systemClock } from '@pepper/core';
import { addMembership, newId, prepareDatabase, withTenant, type DatabaseHandle } from '@pepper/db';
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
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// Client import through the api against real Postgres and Redis (S48, ADR-0049, AC-W1-3,
// AC-W1-17…19): an owner uploads a tool's export, fixes the mapping, commits, the worker's job
// runs it, a re-import changes nothing and undo takes it back; staff are refused, and one
// business never reaches another's import.

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';
const fixture = (name: string) =>
  readFileSync(new URL(`../../../packages/modules/imports/src/fixtures/${name}`, import.meta.url));

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
    upload: (bytes: Buffer, type = 'text/csv', query = '') =>
      send(agent.post(`/v1/imports${query}`))
        .set('content-type', type)
        .send(bytes),
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

/** An owner with a business and a second factor, and a staff member of it. */
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
  const staff = await signUp('Jess Moreno');
  await withTenant(database.db, tenantId, (tx) =>
    addMembership(tx, { userId: UserIdSchema.parse(staff.userId), role: 'staff' }),
  );
  await staff.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return { tenantId, owner: owner.browser, staff: staff.browser };
}

async function clientCount(b: Browser): Promise<number> {
  return ((await b.get('/v1/clients?limit=200').expect(200)).body as { clients: unknown[] }).clients
    .length;
}

describe('client import through the api (S48)', () => {
  it('uploads, remaps, commits, runs, re-imports without duplicates and undoes', async () => {
    const b = await business();
    const staged = ImportPreviewSchema.parse(
      (await b.owner.upload(fixture('fresha.csv')).expect(201)).body,
    );
    expect(staged.batch).toMatchObject({
      status: 'staged',
      preset: 'fresha',
      counts: { create: 3 },
    });
    expect(await clientCount(b.owner)).toBe(0);

    // The owner leaves the landline out: the preview follows.
    const columns = staged.batch.columns.map(({ column, field }) => ({
      column,
      field: column === 'Telephone' ? null : field,
    }));
    const remapped = ImportPreviewSchema.parse(
      (await b.owner.put(`/v1/imports/${staged.batch.id}/mapping`, { columns }).expect(200)).body,
    );
    expect(remapped.batch.columns.find((c) => c.column === 'Telephone')).toMatchObject({
      field: null,
      by: null,
    });

    const committed = ImportBatchSchema.parse(
      (await b.owner.post(`/v1/imports/${staged.batch.id}/commit`).expect(202)).body,
    );
    expect(committed.status).toBe('queued');
    await runImport(database.db, { batchId: committed.id, tenantId: b.tenantId }, systemClock);
    const done = ImportPreviewSchema.parse(
      (await b.owner.get(`/v1/imports/${committed.id}`).expect(200)).body,
    );
    expect(done.batch).toMatchObject({ status: 'done', counts: { create: 3 } });
    expect(await clientCount(b.owner)).toBe(3);

    // Again with the suggested mapping: the landline left out before now fills Ethan's phone.
    const again = ImportPreviewSchema.parse(
      (await b.owner.upload(fixture('fresha.csv')).expect(201)).body,
    );
    expect(again.batch.counts).toMatchObject({ create: 0, merge: 1, unchanged: 2 });
    await b.owner.post(`/v1/imports/${again.batch.id}/commit`).expect(202);
    await runImport(database.db, { batchId: again.batch.id, tenantId: b.tenantId }, systemClock);
    // A third time there is nothing to do, and nothing to commit.
    const third = ImportPreviewSchema.parse(
      (await b.owner.upload(fixture('fresha.csv')).expect(201)).body,
    );
    expect(third.batch.counts).toMatchObject({ create: 0, merge: 0, unchanged: 3 });
    const refused = await b.owner.post(`/v1/imports/${third.batch.id}/commit`).expect(409);
    expect(refused.body).toMatchObject({ code: 'import_not_ready' });
    expect(await clientCount(b.owner)).toBe(3);

    const undone = ImportBatchSchema.parse(
      (await b.owner.post(`/v1/imports/${committed.id}/undo`).expect(200)).body,
    );
    expect(undone).toMatchObject({ status: 'undone', undo: { deleted: 3, restored: 0, kept: 0 } });
    expect(await clientCount(b.owner)).toBe(0);
    const listed = (await b.owner.get('/v1/imports').expect(200)).body as { id: string }[];
    expect(listed.map((batch) => batch.id)).toEqual([third.batch.id, again.batch.id, committed.id]);
  });

  it('takes JSON sent as bytes and says what is wrong with a broken file', async () => {
    const b = await business();
    const json = await b.owner
      .upload(fixture('own-app.json'), 'application/octet-stream')
      .expect(201);
    expect(ImportPreviewSchema.parse(json.body).batch).toMatchObject({
      format: 'json',
      counts: { create: 3 },
    });
    const broken = await b.owner.upload(Buffer.from('[{"name":'), 'application/octet-stream');
    expect([broken.status, broken.body]).toEqual([
      422,
      {
        code: 'import_rejected',
        message: 'Pepper couldn’t read this file as JSON. Export it again as CSV, JSON or JSONL.',
        reason: 'unreadable',
      },
    ]);
    await b.owner.post('/v1/imports', [{ name: 'Ana' }]).expect(415);
  });

  it('refuses staff, and keeps one business’s import from another', async () => {
    const mine = await business();
    const theirs = await business();
    const staged = ImportPreviewSchema.parse(
      (await theirs.owner.upload(fixture('booksy.csv')).expect(201)).body,
    );
    expect((await mine.staff.upload(fixture('booksy.csv')).expect(403)).body).toMatchObject({
      code: 'forbidden',
    });
    await mine.staff.get('/v1/imports').expect(403);
    const id = staged.batch.id;
    await mine.owner.get(`/v1/imports/${id}`).expect(404);
    await mine.owner.post(`/v1/imports/${id}/commit`).expect(404);
    await mine.owner.post(`/v1/imports/${id}/undo`).expect(404);
    expect((await mine.owner.get('/v1/imports').expect(200)).body).toEqual([]);
  });
});
