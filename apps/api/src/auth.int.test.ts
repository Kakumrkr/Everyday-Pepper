import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  ApiErrorSchema,
  AuditLogResponseSchema,
  CreateInviteResponseSchema,
  CurrentBusinessResponseSchema,
  InvitesResponseSchema,
  MeResponseSchema,
  MembersResponseSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@floty/contracts';
import {
  accounts,
  addMembership,
  auditLog,
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
    patch: (path: string, body: object) => send(agent.patch(path)).send(body),
    delete: (path: string) => send(agent.delete(path)),
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

  it("cannot set the session's business through Better Auth's own endpoints", async () => {
    const before = (await me(ben)).activeTenantId;
    const response = await ben.post('/api/auth/update-session', { activeTenantId: anaTenant });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await me(ben)).activeTenantId).toBe(before);
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

describe('team and audit log (ADR-0013)', () => {
  let ana: Browser;
  let ben: Browser;
  let cara: Browser;
  let caraEmail: string;
  let ids: { ana: string; ben: string; cara: string };
  let tenantId: string;

  beforeAll(async () => {
    ({ browser: ana } = await signUp('ana'));
    ({ browser: ben } = await signUp('ben'));
    ({ browser: cara, email: caraEmail } = await signUp('cara'));
    ids = {
      ana: (await me(ana)).user.id,
      ben: (await me(ben)).user.id,
      cara: (await me(cara)).user.id,
    };
    tenantId = (
      (await ana.post('/v1/tenants', { ...juniper, slug: 'team-salon' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await enrolTotp(ana);
    await withTenant(db, TenantIdSchema.parse(tenantId), async (tx) => {
      await addMembership(tx, { userId: UserIdSchema.parse(ids.ben), role: 'manager' });
      await addMembership(tx, { userId: UserIdSchema.parse(ids.cara), role: 'staff' });
    });
    await ben.put('/v1/me/active-tenant', { tenantId }).expect(204);
    await cara.put('/v1/me/active-tenant', { tenantId }).expect(204);
  });

  async function members(b: Browser) {
    return MembersResponseSchema.parse((await b.get('/v1/members').expect(200)).body).members;
  }

  it('a manager needs a second factor before working in the business', async () => {
    expect(errorCode((await ben.get('/v1/members').expect(403)).body)).toBe('mfa_required');
    await enrolTotp(ben);
    expect((await members(ben)).map((m) => [m.userId, m.role])).toEqual([
      [ids.ana, 'owner'],
      [ids.ben, 'manager'],
      [ids.cara, 'staff'],
    ]);
  });

  it('staff can open the business but not see the team or the audit log', async () => {
    await cara.get('/v1/tenant').expect(200);
    expect(errorCode((await cara.get('/v1/members').expect(403)).body)).toBe('forbidden');
    expect(errorCode((await cara.get('/v1/audit-log').expect(403)).body)).toBe('forbidden');
    const patched = await cara.patch(`/v1/members/${ids.cara}`, { role: 'owner' }).expect(403);
    expect(errorCode(patched.body)).toBe('forbidden');
  });

  it('the owner changes a role; the audit log records who, what and the request', async () => {
    const response = await ana.patch(`/v1/members/${ids.cara}`, { role: 'manager' }).expect(200);
    expect(response.body).toMatchObject({ userId: ids.cara, role: 'manager' });
    // Back to staff, so Cara keeps working without a second factor.
    await ana.patch(`/v1/members/${ids.cara}`, { role: 'staff' }).expect(200);

    const log = AuditLogResponseSchema.parse(
      (await ana.get('/v1/audit-log?limit=2').expect(200)).body,
    );
    expect(log.entries.map((e) => [e.action, e.before, e.after])).toEqual([
      [
        'membership.role_changed',
        { userId: ids.cara, role: 'manager' },
        { userId: ids.cara, role: 'staff' },
      ],
      [
        'membership.role_changed',
        { userId: ids.cara, role: 'staff' },
        { userId: ids.cara, role: 'manager' },
      ],
    ]);
    expect(log.entries[1]?.actor).toEqual({ kind: 'user', userId: ids.ana });
    expect(log.nextBefore).not.toBeNull();
    const [row] = await withTenant(db, TenantIdSchema.parse(tenantId), (tx) =>
      tx
        .select({ requestId: auditLog.requestId })
        .from(auditLog)
        .where(eq(auditLog.id, log.entries[1]?.id ?? '')),
    );
    expect(row?.requestId).toBe(response.headers['x-request-id']);
  });

  it('records the business creation too', async () => {
    const log = AuditLogResponseSchema.parse((await ben.get('/v1/audit-log').expect(200)).body);
    expect(log.entries.at(-1)).toMatchObject({
      action: 'tenant.created',
      entity: { type: 'tenant', id: tenantId },
      actor: { kind: 'user', userId: ids.ana },
    });
  });

  it('a manager cannot change or remove the owner, nor make anyone an owner', async () => {
    expect(
      errorCode((await ben.patch(`/v1/members/${ids.ana}`, { role: 'staff' }).expect(403)).body),
    ).toBe('forbidden');
    expect(errorCode((await ben.delete(`/v1/members/${ids.ana}`).expect(403)).body)).toBe(
      'forbidden',
    );
    expect(
      errorCode((await ben.patch(`/v1/members/${ids.cara}`, { role: 'owner' }).expect(403)).body),
    ).toBe('forbidden');
  });

  it('someone from another business is not found here', async () => {
    const { browser: dan } = await signUp('dan');
    const danId = (await me(dan)).user.id;
    await dan.post('/v1/tenants', { ...juniper, slug: 'dan-studio' }).expect(201);
    const response = await ana.patch(`/v1/members/${danId}`, { role: 'staff' }).expect(404);
    expect(errorCode(response.body)).toBe('member_not_found');
    expect((await me(dan)).businesses.map((b) => b.role)).toEqual(['owner']);
  });

  it('the last owner cannot leave', async () => {
    const response = await ana.delete(`/v1/members/${ids.ana}`).expect(409);
    expect(errorCode(response.body)).toBe('last_owner');
  });

  it('staff can leave; their session then has no business', async () => {
    await cara.delete(`/v1/members/${ids.cara}`).expect(204);
    expect(await me(cara)).toMatchObject({ activeTenantId: null, businesses: [] });
    expect(errorCode((await cara.get('/v1/tenant').expect(403)).body)).toBe('no_active_tenant');
    const log = AuditLogResponseSchema.parse(
      (await ana.get('/v1/audit-log?limit=1').expect(200)).body,
    );
    expect(log.entries[0]).toMatchObject({
      action: 'membership.removed',
      actor: { kind: 'user', userId: ids.cara },
      before: { userId: ids.cara, role: 'staff' },
    });
  });

  it('logs no emails from the team endpoints (the member list carries them)', () => {
    expect(JSON.stringify(logLines)).not.toContain(caraEmail);
  });

  it('one user may own at most 5 businesses', async () => {
    for (let i = 2; i <= 5; i++) {
      await ana.post('/v1/tenants', { ...juniper, slug: `team-salon-${String(i)}` }).expect(201);
    }
    const response = await ana
      .post('/v1/tenants', { ...juniper, slug: 'team-salon-6' })
      .expect(409);
    expect(errorCode(response.body)).toBe('business_limit_reached');
    expect((await me(ana)).businesses).toHaveLength(5);
  });
});

describe('invites (ADR-0014)', () => {
  let ana: Browser;
  let tenantId: string;
  const tokens: string[] = [];
  const inviteeEmails: string[] = [];

  beforeAll(async () => {
    ({ browser: ana } = await signUp('ana'));
    tenantId = (
      (await ana.post('/v1/tenants', { ...juniper, slug: 'invite-salon' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await enrolTotp(ana);
  });

  async function invite(by: Browser, email: string, role: string) {
    const response = await by.post('/v1/invites', { email, role }).expect(201);
    const created = CreateInviteResponseSchema.parse(response.body);
    tokens.push(created.token);
    inviteeEmails.push(email);
    return created;
  }

  it('an owner invites a manager who signs up with that email, accepts and must set up MFA', async () => {
    const email = newEmail('jess');
    inviteeEmails.push(email);
    const { invite: created, token } = await invite(ana, email.toUpperCase(), 'manager');
    expect(created).toMatchObject({ email, role: 'manager' });
    const listed = InvitesResponseSchema.parse((await ana.get('/v1/invites').expect(200)).body);
    expect(listed.invites.map((i) => i.id)).toEqual([created.id]);

    const jess = browser();
    await jess.post('/api/auth/sign-up/email', { name: 'Jess', email, password: PASSWORD });
    expect((await me(jess)).businesses).toEqual([]);
    const preview = await jess.post('/v1/invites/lookup', { token }).expect(200);
    expect(preview.body).toMatchObject({ businessName: juniper.name, role: 'manager' });

    const accepted = await jess.post('/v1/invites/accept', { token }).expect(200);
    expect(accepted.body).toEqual({ tenantId, role: 'manager' });
    expect(await me(jess)).toMatchObject({
      activeTenantId: tenantId,
      businesses: [{ tenantId, role: 'manager' }],
    });
    // A manager works in the business only with a second factor.
    expect(errorCode((await jess.get('/v1/tenant').expect(403)).body)).toBe('mfa_required');
    await enrolTotp(jess);
    const current = CurrentBusinessResponseSchema.parse(
      (await jess.get('/v1/tenant').expect(200)).body,
    );
    expect(current.permissions).toContain('members.invite');
    expect(current.permissions).not.toContain('billing.manage');

    // Single use, and no longer listed.
    expect(errorCode((await jess.post('/v1/invites/accept', { token }).expect(404)).body)).toBe(
      'invite_invalid',
    );
    expect(InvitesResponseSchema.parse((await ana.get('/v1/invites').expect(200)).body)).toEqual({
      invites: [],
    });

    // Audited without the email, with the request id.
    const log = AuditLogResponseSchema.parse(
      (await ana.get('/v1/audit-log?limit=2').expect(200)).body,
    );
    expect(log.entries.map((e) => e.action)).toEqual(['invite.accepted', 'invite.created']);
    expect(JSON.stringify(log)).not.toContain('jess');
    const [row] = await withTenant(db, TenantIdSchema.parse(tenantId), (tx) =>
      tx
        .select({ requestId: auditLog.requestId })
        .from(auditLog)
        .where(eq(auditLog.id, log.entries[0]?.id ?? '')),
    );
    expect(row?.requestId).toBe(accepted.headers['x-request-id']);
  });

  it('a forwarded link is refused for anyone else, and reveals nothing', async () => {
    const email = newEmail('priya');
    const { token } = await invite(ana, email, 'staff');
    const { browser: stranger } = await signUp('stranger');
    for (const path of ['/v1/invites/lookup', '/v1/invites/accept']) {
      const response = await stranger.post(path, { token }).expect(403);
      expect(response.body).toEqual({
        code: 'invite_wrong_account',
        message: expect.any(String) as string,
      });
    }
    expect((await me(stranger)).businesses).toEqual([]);
  });

  it('a revoked invite no longer works; revoking it again is not found', async () => {
    const email = newEmail('marco');
    const { invite: created, token } = await invite(ana, email, 'staff');
    await ana.delete(`/v1/invites/${created.id}`).expect(204);
    const marco = browser();
    await marco.post('/api/auth/sign-up/email', { name: 'Marco', email, password: PASSWORD });
    expect(errorCode((await marco.post('/v1/invites/accept', { token }).expect(404)).body)).toBe(
      'invite_invalid',
    );
    expect(errorCode((await ana.delete(`/v1/invites/${created.id}`).expect(404)).body)).toBe(
      'invite_not_found',
    );
  });

  it('nobody grants a role they may not: managers cannot invite owners, staff cannot invite', async () => {
    const email = newEmail('staffer');
    const { token } = await invite(ana, email, 'staff');
    const staffer = browser();
    await staffer.post('/api/auth/sign-up/email', { name: 'Staffer', email, password: PASSWORD });
    await staffer.post('/v1/invites/accept', { token }).expect(200);
    const asStaff = await staffer.post('/v1/invites', { email: newEmail('x'), role: 'staff' });
    expect([asStaff.status, errorCode(asStaff.body)]).toEqual([403, 'forbidden']);
    expect(errorCode((await staffer.get('/v1/invites').expect(403)).body)).toBe('forbidden');

    const managerEmail = newEmail('mgr');
    const { token: managerToken } = await invite(ana, managerEmail, 'manager');
    const manager = browser();
    await manager.post('/api/auth/sign-up/email', {
      name: 'Mgr',
      email: managerEmail,
      password: PASSWORD,
    });
    await manager.post('/v1/invites/accept', { token: managerToken }).expect(200);
    await enrolTotp(manager);
    const asManager = await manager.post('/v1/invites', { email: newEmail('y'), role: 'owner' });
    expect([asManager.status, errorCode(asManager.body)]).toEqual([403, 'forbidden']);
    await manager.post('/v1/invites', { email: newEmail('z'), role: 'manager' }).expect(201);
  });

  it("another business cannot see or revoke this business's invites", async () => {
    const { invite: created } = await invite(ana, newEmail('kept'), 'staff');
    const { browser: dan } = await signUp('dan');
    await dan.post('/v1/tenants', { ...juniper, slug: 'dan-invites' }).expect(201);
    await enrolTotp(dan);
    expect(InvitesResponseSchema.parse((await dan.get('/v1/invites').expect(200)).body)).toEqual({
      invites: [],
    });
    expect(errorCode((await dan.delete(`/v1/invites/${created.id}`).expect(404)).body)).toBe(
      'invite_not_found',
    );
  });

  it('refuses to invite an existing member', async () => {
    const anaEmail = (await me(ana)).user.email;
    const response = await ana.post('/v1/invites', { email: anaEmail, role: 'staff' }).expect(409);
    expect(errorCode(response.body)).toBe('already_a_member');
  });

  it('logs no invite tokens or invitee emails', () => {
    const logged = JSON.stringify(logLines);
    for (const token of tokens) expect(logged).not.toContain(token);
    for (const email of inviteeEmails) expect(logged.toLowerCase()).not.toContain(email);
  });
});
