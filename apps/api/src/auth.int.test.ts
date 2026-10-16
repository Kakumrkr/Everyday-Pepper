import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  ApiErrorSchema,
  CurrentBusinessResponseSchema,
  MeResponseSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@floty/contracts';
import {
  accounts,
  addMembership,
  prepareDatabase,
  sessions,
  twoFactors,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@floty/db';
import { createLogger, createServiceApp, DATABASE } from '@floty/runtime';
import {
  postgresUrlAs,
  startPostgres,
  startRedis,
  totpCodeFromUri,
  type TestService,
} from '@floty/testing';
import type { INestApplication } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// Sign-up, sign-in with a second factor, businesses and the tenant guard against real Postgres,
// Redis and Better Auth, through the same Nest app and middleware as production.
const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery';

let postgres: TestService;
let redis: TestService;
let app: INestApplication;
let server: Server;
let db: Database;
const logLines: Record<string, unknown>[] = [];
let ipCounter = 0;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'floty_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    AUTH_BASE_URL: ORIGIN,
    LOG_LEVEL: 'info',
  });
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.startsWith('{')) logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      done();
    },
  });
  app = await createServiceApp(AppModule.forRoot(config), config, {
    logger: createLogger(config, sink),
  });
  await app.init();
  server = app.getHttpServer() as Server;
  db = app.get<DatabaseHandle>(DATABASE).db;
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop()]);
});

/**
 * A browser: keeps cookies, sends the app's Origin, and has its own client address (Better
 * Auth rate limits per address and path, so separate users do not share a bucket).
 */
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
  };
}
type Browser = ReturnType<typeof browser>;

let emailCounter = 0;
function newEmail(name: string): string {
  emailCounter += 1;
  return `${name}.${String(emailCounter)}@example.test`;
}

async function signUp(name: string): Promise<{ browser: Browser; email: string }> {
  const b = browser();
  const email = newEmail(name);
  await b.post('/api/auth/sign-up/email', { name, email, password: PASSWORD }).expect(200);
  return { browser: b, email };
}

async function me(b: Browser) {
  return MeResponseSchema.parse((await b.get('/v1/me').expect(200)).body);
}

/** Sets up TOTP; returns the otpauth URI (what the QR code shows). */
async function enrolTotp(b: Browser): Promise<string> {
  const enabled = await b.post('/api/auth/two-factor/enable', { password: PASSWORD }).expect(200);
  const { totpURI, backupCodes } = enabled.body as { totpURI: string; backupCodes: string[] };
  expect(backupCodes.length).toBeGreaterThan(0);
  await b.post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpURI) }).expect(200);
  return totpURI;
}

function errorCode(body: unknown): string {
  return ApiErrorSchema.parse(body).code;
}

const juniper = { name: 'Juniper Hair Studio', timeZone: 'America/New_York' };

describe('owner journey', () => {
  let ana: Browser;
  let anaEmail: string;
  let totpUri: string;
  let tenantId: string;

  it('signs up with a session cookie that scripts cannot read', async () => {
    const b = browser();
    anaEmail = newEmail('ana');
    const response = await b
      .post('/api/auth/sign-up/email', { name: 'Ana Reyes', email: anaEmail, password: PASSWORD })
      .expect(200);
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('floty.session_token='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Path=\//);
    ana = b;
  });

  it('starts with no business and no second factor', async () => {
    expect(await me(ana)).toMatchObject({
      user: { name: 'Ana Reyes', email: anaEmail, twoFactorEnabled: false },
      activeTenantId: null,
      businesses: [],
    });
    expect(errorCode((await ana.get('/v1/tenant').expect(403)).body)).toBe('no_active_tenant');
  });

  it('creates a business, which becomes active, but needs MFA to work in it', async () => {
    const created = await ana.post('/v1/tenants', { ...juniper, slug: 'juniper' }).expect(201);
    tenantId = TenantIdSchema.parse((created.body as { id: string }).id);
    expect(await me(ana)).toMatchObject({
      activeTenantId: tenantId,
      businesses: [{ tenantId, name: juniper.name, slug: 'juniper', role: 'owner' }],
    });
    expect(errorCode((await ana.get('/v1/tenant').expect(403)).body)).toBe('mfa_required');
  });

  it('sets up TOTP, then works in the business as its owner', async () => {
    totpUri = await enrolTotp(ana);
    expect((await me(ana)).user.twoFactorEnabled).toBe(true);
    const current = CurrentBusinessResponseSchema.parse(
      (await ana.get('/v1/tenant').expect(200)).body,
    );
    expect(current).toMatchObject({ business: { id: tenantId, slug: 'juniper' }, role: 'owner' });
  });

  it('stores no password or TOTP secret in the clear', async () => {
    const userId = (await me(ana)).user.id;
    const [account] = await db.select().from(accounts).where(eq(accounts.userId, userId));
    const [factor] = await db.select().from(twoFactors).where(eq(twoFactors.userId, userId));
    const secret = new URL(totpUri).searchParams.get('secret');
    expect(account?.password).toBeTruthy();
    expect(account?.password).not.toContain(PASSWORD);
    expect(factor?.secret).toBeTruthy();
    expect(factor?.secret).not.toContain(secret);
  });

  it('signs out', async () => {
    await ana.post('/api/auth/sign-out').expect(200);
    expect(errorCode((await ana.get('/v1/me').expect(401)).body)).toBe('unauthenticated');
  });

  it('signs in with password and TOTP, back in the same business', async () => {
    const b = browser();
    const signIn = await b
      .post('/api/auth/sign-in/email', { email: anaEmail.toUpperCase(), password: PASSWORD })
      .expect(200);
    expect(signIn.body).toMatchObject({ twoFactorRedirect: true });
    // The password alone is not a session.
    await b.get('/v1/me').expect(401);
    await b.post('/api/auth/two-factor/verify-totp', { code: '000000' }).expect(401);
    await b.get('/v1/me').expect(401);
    await b
      .post('/api/auth/two-factor/verify-totp', { code: totpCodeFromUri(totpUri) })
      .expect(200);
    expect((await me(b)).activeTenantId).toBe(tenantId);
    await b.get('/v1/tenant').expect(200);
    ana = b;
  });

  it('rejects a wrong password without saying whether the email exists', async () => {
    const b = browser();
    const wrong = await b
      .post('/api/auth/sign-in/email', { email: anaEmail, password: 'not the password' })
      .expect(401);
    const unknown = await b
      .post('/api/auth/sign-in/email', { email: newEmail('nobody'), password: PASSWORD })
      .expect(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('logs the user and tenant of a request, and no credentials', async () => {
    const userId = (await me(ana)).user.id;
    await ana.get('/v1/tenant').expect(200);
    const line = logLines.findLast(
      (l) =>
        l['msg'] === 'request completed' && (l['req'] as { path: string }).path === '/v1/tenant',
    );
    expect(line).toMatchObject({ user_id: userId, tenant_id: tenantId });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(anaEmail);
  });

  it('refuses a duplicate slug', async () => {
    const response = await ana.post('/v1/tenants', { ...juniper, slug: 'juniper' }).expect(409);
    expect(errorCode(response.body)).toBe('slug_taken');
  });
});

describe('across businesses (AC-X-1)', () => {
  let ana: Browser;
  let ben: Browser;
  let anaTenant: string;
  let benTenant: string;
  let benId: string;

  beforeAll(async () => {
    ({ browser: ana } = await signUp('ana'));
    ({ browser: ben } = await signUp('ben'));
    anaTenant = (
      (await ana.post('/v1/tenants', { ...juniper, slug: 'ana-salon' }).expect(201)).body as {
        id: string;
      }
    ).id;
    benTenant = (
      (await ben.post('/v1/tenants', { ...juniper, slug: 'ben-barber' }).expect(201)).body as {
        id: string;
      }
    ).id;
    benId = (await me(ben)).user.id;
  });

  it("does not list or switch to another user's business", async () => {
    expect((await me(ben)).businesses.map((b) => b.tenantId)).toEqual([benTenant]);
    const response = await ben.put('/v1/me/active-tenant', { tenantId: anaTenant }).expect(403);
    expect(errorCode(response.body)).toBe('not_a_member');
    expect((await me(ben)).activeTenantId).toBe(benTenant);
  });

  it('ignores a tenant smuggled into the request', async () => {
    // Only the session decides the tenant; ids in headers, query or body are not read.
    await ben
      .put('/v1/me/active-tenant', { tenantId: benTenant, activeTenantId: anaTenant })
      .expect(400);
    const response = await ben
      .get(`/v1/tenant?tenantId=${anaTenant}`)
      .set('x-tenant-id', anaTenant);
    expect(errorCode(response.body)).toBe('mfa_required'); // still Ben's own business
  });

  it('a member works in the business with their role; removal takes effect at once', async () => {
    await withTenant(db, TenantIdSchema.parse(anaTenant), (tx) =>
      addMembership(tx, { userId: UserIdSchema.parse(benId), role: 'staff' }),
    );
    expect((await me(ben)).businesses.map((b) => [b.tenantId, b.role])).toEqual([
      [benTenant, 'owner'],
      [anaTenant, 'staff'],
    ]);
    await ben.put('/v1/me/active-tenant', { tenantId: anaTenant }).expect(204);
    // Staff need no second factor (owners do).
    const current = CurrentBusinessResponseSchema.parse(
      (await ben.get('/v1/tenant').expect(200)).body,
    );
    expect(current).toMatchObject({ business: { id: anaTenant }, role: 'staff' });

    await withTenant(db, TenantIdSchema.parse(anaTenant), (tx) =>
      tx.execute(sql`DELETE FROM memberships WHERE user_id = ${benId}`),
    );
    expect(errorCode((await ben.get('/v1/tenant').expect(403)).body)).toBe('not_a_member');
  });

  it('a session pointed at a foreign business by other means still gets nothing', async () => {
    await db.update(sessions).set({ activeTenantId: anaTenant }).where(eq(sessions.userId, benId));
    expect(errorCode((await ben.get('/v1/tenant').expect(403)).body)).toBe('not_a_member');
  });

  it('rejects writes from another site (CSRF)', async () => {
    const response = await request(server)
      .post('/v1/tenants')
      .set('origin', 'https://evil.example')
      .send({ ...juniper, slug: 'evil' })
      .expect(403);
    expect(errorCode(response.body)).toBe('forbidden_origin');
  });
});

describe('Better Auth safeguards', () => {
  it('stores emails lowercased and refuses a second account for the same email', async () => {
    const b = browser();
    const email = newEmail('Casey').replace('casey', 'Casey');
    await b
      .post('/api/auth/sign-up/email', { name: 'Casey', email, password: PASSWORD })
      .expect(200);
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    expect(row?.email).toBe(email.toLowerCase());
    await browser()
      .post('/api/auth/sign-up/email', {
        name: 'Casey 2',
        email: email.toLowerCase(),
        password: PASSWORD,
      })
      .expect(422);
  });

  it('refuses short passwords', async () => {
    await browser()
      .post('/api/auth/sign-up/email', {
        name: 'Short',
        email: newEmail('short'),
        password: 'abc12345',
      })
      .expect(400);
  });

  it('rate limits repeated sign-in attempts from one address', async () => {
    const b = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const response = await b.post('/api/auth/sign-in/email', {
        email: newEmail('guess'),
        password: 'wrong password',
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });

  it('refuses a cookie-authenticated Better Auth write from another site', async () => {
    const { browser: b } = await signUp('victim');
    // Same agent (has the cookie), but the request claims another origin.
    const agentResponse = await b.post('/api/auth/sign-out').set('origin', 'https://evil.example');
    expect(agentResponse.status).toBe(403);
    await b.get('/v1/me').expect(200);
  });
});
