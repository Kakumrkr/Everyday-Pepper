import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  DELETION_GRACE_DAYS,
  TenantIdSchema,
  UserIdSchema,
  type TenantId,
} from '@pepper/contracts';
import {
  addMembership,
  listAuditEntries,
  newId,
  prepareDatabase,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
import { runDueDeletions, systemClock } from '@pepper/core';
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

// Deleting a business or an account through the api against real Postgres and Redis (S51.2,
// ADR-0054, AC-W1-40, AC-W1-42): the owner schedules the business by its name and can keep
// it; managers and staff can't; while it waits its booking page is closed; after the day the
// worker's pass deletes it. An account is scheduled by its password, ends its other sessions,
// is refused while it alone owns a live business, and is gone after its day.

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
    delete: (path: string) => send(agent.delete(path)),
  };
}
type Browser = ReturnType<typeof browser>;

async function signUp(name: string): Promise<{ browser: Browser; userId: string; email: string }> {
  const b = browser();
  emailCounter += 1;
  const email = `${name.split(' ')[0]?.toLowerCase() ?? 'member'}.${String(emailCounter)}@example.test`;
  const response = await b
    .post('/api/auth/sign-up/email', { name, email, password: PASSWORD })
    .expect(200);
  const userId = (response.body as { user: { id: string } }).user.id;
  await database.db.execute(sql`UPDATE users SET email_verified = true WHERE id = ${userId}`);
  await b.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
  return { browser: b, userId, email };
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
  const slug = (created.body as { slug: string }).slug;
  return { tenantId, slug, owner: owner.browser, ownerId: owner.userId, ownerEmail: owner.email };
}

const DAY_MS = 86_400_000;
/** The worker's pass on a day after the grace period (the database checks its own clock too). */
const later = (days: number) => ({ now: () => new Date(Date.now() + days * DAY_MS) });

/** Moves a business's deletion day into the past, as if the 30 days had gone by. */
async function pastTheDay(tenantId: TenantId): Promise<void> {
  await withTenant(database.db, tenantId, (tx) =>
    tx.execute(sql`UPDATE tenants SET deletion_due_at = now() - interval '1 minute'`),
  );
}

describe('deleting a business (AC-W1-40, AC-W1-41)', () => {
  it('the owner schedules it by its name, the page closes, and it can be kept', async () => {
    const b = await business();
    await b.owner.get('/v1/tenant/deletion').expect(200, { dueAt: null });
    const page = () => request(server).get(`/v1/public/businesses/${b.slug}`);
    await page().expect(200);

    const wrong = await b.owner.post('/v1/tenant/deletion', { confirmName: 'Fade' }).expect(400);
    expect((wrong.body as { code: string }).code).toBe('deletion_name_mismatch');
    const asked = Date.now();
    const scheduled = await b.owner
      .post('/v1/tenant/deletion', { confirmName: '  fade   LAB ' })
      .expect(200);
    const dueAt = Date.parse((scheduled.body as { dueAt: string }).dueAt);
    expect(dueAt - asked).toBeGreaterThanOrEqual(DELETION_GRACE_DAYS * DAY_MS - 60_000);
    expect(dueAt - asked).toBeLessThanOrEqual(DELETION_GRACE_DAYS * DAY_MS + 60_000);
    // Asking again keeps the first day.
    const again = await b.owner
      .post('/v1/tenant/deletion', { confirmName: 'Fade Lab' })
      .expect(200);
    expect(again.body).toEqual(scheduled.body);
    await page().expect(404);
    // The team keeps working meanwhile.
    await b.owner.get('/v1/services').expect(200);

    await b.owner.delete('/v1/tenant/deletion').expect(200, { dueAt: null });
    await page().expect(200);
    const audit = await withTenant(database.db, b.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 100 }),
    );
    const actions = audit.map((entry) => entry.action);
    expect(actions).toEqual(
      expect.arrayContaining(['business.deletion_scheduled', 'business.deletion_cancelled']),
    );
    expect(actions.filter((action) => action === 'business.deletion_scheduled')).toHaveLength(1);
  });

  it('managers and staff can see it but not schedule or keep it', async () => {
    const b = await business();
    for (const role of ['manager', 'staff'] as const) {
      const someone = await member(b.tenantId, role);
      if (role === 'manager') {
        // Managers need a second factor before working in the business.
        const enabled = await someone
          .post('/api/auth/two-factor/enable', { password: PASSWORD })
          .expect(200);
        await someone
          .post('/api/auth/two-factor/verify-totp', {
            code: totpCodeFromUri((enabled.body as { totpURI: string }).totpURI),
          })
          .expect(200);
      }
      await someone.get('/v1/tenant/deletion').expect(200, { dueAt: null });
      await someone.post('/v1/tenant/deletion', { confirmName: 'Fade Lab' }).expect(403);
      await someone.delete('/v1/tenant/deletion').expect(403);
    }
  });

  it('after the day the worker deletes it; the owner signs in to no business', async () => {
    const b = await business();
    await b.owner.post('/v1/tenant/deletion', { confirmName: 'Fade Lab' }).expect(200);
    // Not yet: the day hasn't come.
    expect(await runDueDeletions(database.db, { clock: systemClock })).toMatchObject({
      businesses: 0,
    });
    await pastTheDay(b.tenantId);
    const result = await runDueDeletions(database.db, { clock: later(DELETION_GRACE_DAYS + 1) });
    expect(result.businesses).toBe(1);
    const left = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM tenants WHERE id = ${b.tenantId}`,
    );
    expect(left.rows[0]?.n).toBe(0);
    const me = await b.owner.get('/v1/me').expect(200);
    expect(me.body).toMatchObject({ activeTenantId: null, businesses: [] });
    await b.owner.get('/v1/tenant/deletion').expect(403);
  });
});

describe('deleting an account (AC-W1-42)', () => {
  it('asks for the password, ends the other sessions, can be kept', async () => {
    const { browser: phone, email } = await signUp('Lee Park');
    const laptop = browser();
    await laptop.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
    await phone.get('/v1/me/deletion').expect(200, { dueAt: null });

    const wrong = await phone.post('/v1/me/deletion', { password: 'not the password' }).expect(400);
    expect((wrong.body as { code: string }).code).toBe('wrong_password');
    await laptop.get('/v1/me').expect(200);

    const scheduled = await phone.post('/v1/me/deletion', { password: PASSWORD }).expect(200);
    expect((scheduled.body as { dueAt: string | null }).dueAt).not.toBeNull();
    await laptop.get('/v1/me').expect(401);
    // The account still signs in while it waits, so its owner can keep it.
    await phone.get('/v1/me').expect(200);
    await phone.delete('/v1/me/deletion').expect(200, { dueAt: null });
    await phone.get('/v1/me/deletion').expect(200, { dueAt: null });
  });

  it('limits password tries', async () => {
    const { browser: b } = await signUp('Max Try');
    for (let i = 0; i < 5; i += 1) {
      await b.post('/v1/me/deletion', { password: 'wrong guess' }).expect(400);
    }
    await b.post('/v1/me/deletion', { password: PASSWORD }).expect(429);
  });

  it('the only owner of a business must delete the business first', async () => {
    const b = await business();
    const refused = await b.owner.post('/v1/me/deletion', { password: PASSWORD }).expect(409);
    expect((refused.body as { code: string }).code).toBe('account_owns_business');
    await b.owner.post('/v1/tenant/deletion', { confirmName: 'Fade Lab' }).expect(200);
    await b.owner.post('/v1/me/deletion', { password: PASSWORD }).expect(200);
    // Keeping the business now would leave it with an owner who is leaving.
    const keep = await b.owner.delete('/v1/tenant/deletion').expect(409);
    expect((keep.body as { code: string }).code).toBe('account_being_deleted');

    // After the days, both go; the owner's sign-in no longer works.
    await pastTheDay(b.tenantId);
    await database.db.execute(
      sql`UPDATE users SET deletion_due_at = now() - interval '1 minute' WHERE id = ${b.ownerId}`,
    );
    const result = await runDueDeletions(database.db, { clock: later(DELETION_GRACE_DAYS + 1) });
    expect(result).toMatchObject({ businesses: 1, accounts: 1 });
    await b.owner.get('/v1/me').expect(401);
    await browser()
      .post('/api/auth/sign-in/email', { email: b.ownerEmail, password: PASSWORD })
      .expect(401);
    const rows = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM users WHERE id = ${b.ownerId}`,
    );
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('a staff member’s account goes; the business keeps its records', async () => {
    const b = await business();
    const joined = await signUp('Jess Moreno');
    await withTenant(database.db, b.tenantId, (tx) =>
      addMembership(tx, { userId: UserIdSchema.parse(joined.userId), role: 'staff' }),
    );
    await joined.browser.post('/v1/me/deletion', { password: PASSWORD }).expect(200);
    await database.db.execute(
      sql`UPDATE users SET deletion_due_at = now() - interval '1 minute' WHERE id = ${joined.userId}`,
    );
    expect(await runDueDeletions(database.db, { clock: systemClock })).toMatchObject({
      accounts: 1,
      businesses: 0,
    });
    const members = await b.owner.get('/v1/members').expect(200);
    expect(JSON.stringify(members.body)).not.toContain(joined.email);
    await b.owner.get('/v1/tenant').expect(200);
  });
});
