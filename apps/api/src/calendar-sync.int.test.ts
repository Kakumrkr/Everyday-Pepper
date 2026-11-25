import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  CalendarConnectionAnswerSchema,
  CalendarConnectStartSchema,
  OutsideBusyResponseSchema,
  TeamCalendarConnectionsSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@pepper/contracts';
import {
  addMembership,
  insertStaffMember,
  newId,
  prepareDatabase,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
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

// Google Calendar through the api against real Postgres and Redis (S70, ADR-0069,
// AC-X-152…159): the whole app as configured from its environment, with the sandbox and off.

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';

let postgres: TestService;
let redis: TestService;
let sandboxApp: INestApplication;
let offApp: INestApplication;
let sandboxServer: Server;
let offServer: Server;
let database: DatabaseHandle;

async function startApp(env: Record<string, string>): Promise<INestApplication> {
  const config = loadApiConfig({
    DATABASE_URL: postgresUrlAs(postgres.url, 'pepper_service', 'test-password'),
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'warn',
    ...env,
  });
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const app = await createServiceApp(AppModule.forRoot(config), config, {
    logger: createLogger(config, sink),
  });
  await app.init();
  return app;
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  await prepareDatabase(
    postgres.url,
    postgresUrlAs(postgres.url, 'pepper_service', 'test-password'),
  );
  sandboxApp = await startApp({ GOOGLE_CALENDAR_PROVIDER: 'sandbox' });
  offApp = await startApp({});
  sandboxServer = sandboxApp.getHttpServer() as Server;
  offServer = offApp.getHttpServer() as Server;
  database = sandboxApp.get<DatabaseHandle>(DATABASE);
}, 180_000);

afterAll(async () => {
  await Promise.all([sandboxApp.close(), offApp.close()]);
  await Promise.all([postgres.stop(), redis.stop()]);
});

let ipCounter = 0;
let emailCounter = 0;

function browser(server: Server) {
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

async function signUp(server: Server, name: string): Promise<{ browser: Browser; userId: string }> {
  const b = browser(server);
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

/** An owner with a business, a staff member who takes bookings, and one who has no column. */
async function business(server: Server) {
  const owner = await signUp(server, 'Ana Reyes');
  const created = await owner.browser
    .post('/v1/tenants', {
      name: 'Fade Lab',
      timeZone: 'America/New_York',
      slug: `gcal-${newId().slice(-8)}`,
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
  const jess = await signUp(server, 'Jess Moreno');
  const staffMemberId = await withTenant(database.db, tenantId, async (tx) => {
    const membership = await addMembership(tx, {
      userId: UserIdSchema.parse(jess.userId),
      role: 'staff',
    });
    const staff = await insertStaffMember(tx, {
      displayName: 'Jess',
      color: '#2a7230',
      active: true,
      membershipId: membership.id,
    });
    return staff.id;
  });
  await jess.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return { tenantId, owner: owner.browser, jess: jess.browser, staffMemberId };
}

async function connect(b: Browser): Promise<string> {
  const started = CalendarConnectStartSchema.parse(
    (await b.post('/v1/calendar/google/connect').expect(200)).body,
  );
  const back = new URL(started.url);
  expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/more/calendar/google`);
  const code = back.searchParams.get('code') ?? '';
  const state = back.searchParams.get('state') ?? '';
  const answer = await b.post('/v1/calendar/google/callback', { code, state }).expect(200);
  return JSON.stringify(answer.body);
}

const WEEK = '?from=2026-11-30T05:00:00.000Z&to=2026-12-07T05:00:00.000Z';

describe('Google Calendar with the sandbox (AC-X-152, AC-X-157, AC-X-159)', () => {
  it('a staff member connects their own calendar; everyone sees the busy times, never what', async () => {
    const { owner, jess, staffMemberId } = await business(sandboxServer);
    expect((await jess.get('/v1/calendar/google').expect(200)).body).toEqual({
      canConnect: true,
      connection: null,
    });
    const answer = CalendarConnectionAnswerSchema.parse(JSON.parse(await connect(jess)));
    expect(answer.connection).toMatchObject({
      staffMemberId,
      provider: 'sandbox',
      accountEmail: 'calendar@sandbox.test',
      status: 'connected',
    });

    // The sandbox is busy 17:00–18:00 UTC every day, read from a week back to 60 days ahead
    // of the real clock: ask about the week from now.
    const now = Date.now();
    const range = `?from=${new Date(now).toISOString()}&to=${new Date(now + 7 * 86_400_000).toISOString()}`;
    const busy = OutsideBusyResponseSchema.parse(
      (
        await owner
          .get(`/v1/calendar/outside-busy${range}&staffMemberId=${staffMemberId}`)
          .expect(200)
      ).body,
    );
    expect(busy.busy.length).toBeGreaterThanOrEqual(6);
    expect(new Set(busy.busy.map((b) => `${b.staffMemberId} ${b.source}`))).toEqual(
      new Set([`${staffMemberId} google`]),
    );
    expect(busy.busy.every((b) => new Date(b.startsAt).getUTCHours() === 17)).toBe(true);
    expect(JSON.stringify(busy)).not.toContain('sandbox.test');
  });

  it('the Team list reads each staff member’s state, never the email or another business (AC-X-165)', async () => {
    const { owner, jess, staffMemberId } = await business(sandboxServer);
    expect((await owner.get('/v1/calendar/connections').expect(200)).body).toEqual({
      connections: [],
    });
    await connect(jess);
    const listed = await owner.get('/v1/calendar/connections').expect(200);
    const team = TeamCalendarConnectionsSchema.parse(listed.body);
    expect(team.connections).toHaveLength(1);
    expect(team.connections[0]).toMatchObject({
      staffMemberId,
      provider: 'sandbox',
      status: 'connected',
    });
    expect(team.connections[0]?.syncedAt).not.toBeNull();
    expect(JSON.stringify(listed.body)).not.toContain('sandbox.test');
    expect(JSON.stringify(listed.body)).not.toMatch(/sbx-[ar]-|accountEmail/);
    // A colleague reads the same list (staff.read); another business sees none of it.
    expect((await jess.get('/v1/calendar/connections').expect(200)).body).toEqual(listed.body);
    const other = await business(sandboxServer);
    expect((await other.owner.get('/v1/calendar/connections').expect(200)).body).toEqual({
      connections: [],
    });
  });

  it('the owner, with no staff member of their own, cannot connect', async () => {
    const { owner } = await business(sandboxServer);
    expect((await owner.get('/v1/calendar/google').expect(200)).body).toEqual({
      canConnect: false,
      connection: null,
    });
    const refused = await owner.post('/v1/calendar/google/connect').expect(409);
    expect((refused.body as { code: string }).code).toBe('calendar_not_linked');
  });

  it('refuses a forged state and a malformed answer', async () => {
    const { jess } = await business(sandboxServer);
    await jess.post('/v1/calendar/google/connect').expect(200);
    const forged = await jess
      .post('/v1/calendar/google/callback', { code: 'sandbox-ok', state: 'A'.repeat(43) })
      .expect(400);
    expect((forged.body as { code: string }).code).toBe('calendar_connect_invalid');
    const extra = await jess
      .post('/v1/calendar/google/callback', {
        code: 'x',
        state: 'A'.repeat(43),
        staffMemberId: newId(),
      })
      .expect(400);
    expect((extra.body as { code: string }).code).toBe('validation_failed');
  });

  it('never answers with a token, and disconnects', async () => {
    const { tenantId, jess } = await business(sandboxServer);
    const answered = await connect(jess);
    expect(answered).not.toMatch(/sbx-[ar]-/);
    await jess.delete('/v1/calendar/google').expect(204);
    expect((await jess.get('/v1/calendar/google').expect(200)).body).toEqual({
      canConnect: true,
      connection: null,
    });
    const left = await withTenant(database.db, tenantId, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM calendar_busy_blocks`),
    );
    expect((left.rows[0] as { n: number }).n).toBe(0);
    const again = await jess.delete('/v1/calendar/google').expect(404);
    expect((again.body as { code: string }).code).toBe('calendar_not_connected');
  });
});

describe('Google Calendar off (AC-X-158)', () => {
  it('every connection route is 404; stored busy times still read (none)', async () => {
    const { jess } = await business(offServer);
    const calls = [
      () => jess.get('/v1/calendar/google'),
      () => jess.get('/v1/calendar/connections'),
      () => jess.post('/v1/calendar/google/connect'),
      () => jess.post('/v1/calendar/google/callback', { code: 'x', state: 'A'.repeat(43) }),
      () => jess.delete('/v1/calendar/google'),
    ];
    for (const call of calls) {
      const response = await call().expect(404);
      expect((response.body as { code: string }).code).toBe('calendar_off');
    }
    expect((await jess.get(`/v1/calendar/outside-busy${WEEK}`).expect(200)).body).toEqual({
      busy: [],
      truncated: false,
    });
  });
});
