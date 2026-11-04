import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import { addDays, formatDate, fromZoned, parseDate, toZoned } from '@pepper/appointments';
import {
  ApiErrorSchema,
  AuditLogResponseSchema,
  AvailabilityResponseSchema,
  BookingRulesResponseSchema,
  PLATFORM_RULE_DEFAULTS,
  BookingSchema,
  BookingsResponseSchema,
  BusyResponseSchema,
  ClientSchema,
  ClientsResponseSchema,
  minutesOfDay,
  SlotUnavailableSchema,
  WaitlistEntrySchema,
  WaitlistResponseSchema,
  type Client,
  type Service,
  type StaffMember,
  CreateInviteResponseSchema,
  CurrentBusinessResponseSchema,
  InvitesResponseSchema,
  MeResponseSchema,
  MembersResponseSchema,
  ServiceSchema,
  StaffMemberSchema,
  StaffResponseSchema,
  TemplateIdSchema,
  TemplatesResponseSchema,
  TenantIdSchema,
  TimeOffResponseSchema,
  TimeOffSchema,
  WaitlistTimesFreeSchema,
  WeeklyHoursSchema,
  UserIdSchema,
} from '@pepper/contracts';
import {
  accounts,
  activationEvents,
  addMembership,
  auditLog,
  prepareDatabase,
  sessions,
  signupEvents,
  twoFactors,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { createLogger, createServiceApp, DATABASE } from '@pepper/runtime';
import {
  postgresUrlAs,
  startMailpit,
  startPostgres,
  startRedis,
  totpCodeFromUri,
  type TestMailpit,
  type TestService,
} from '@pepper/testing';
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
let mailpit: TestMailpit;
let app: INestApplication;
let server: Server;
let db: Database;
const logLines: Record<string, unknown>[] = [];
let ipCounter = 0;

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([startPostgres(), startRedis(), startMailpit()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redis.url,
    AUTH_SECRET: 'an-integration-test-secret-32-chars',
    OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
    AUTH_BASE_URL: ORIGIN,
    SMTP_URL: mailpit.smtpUrl,
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
  await Promise.all([postgres.stop(), redis.stop(), mailpit.stop()]);
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

/** The emails Mailpit holds for `to`, newest first. */
async function inbox(to: string): Promise<{ ID: string; Subject: string }[]> {
  const search = await fetch(
    `${mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await search.json()) as { messages: { ID: string; Subject: string }[] }).messages;
}

/** The text of the newest email to `to` with `subject` in its subject, waiting for it. */
async function emailTo(to: string, subject: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = (await inbox(to)).find((message) => message.Subject.includes(subject));
    if (found !== undefined) {
      const message = await fetch(`${mailpit.apiUrl}/api/v1/message/${found.ID}`);
      return ((await message.json()) as { Text: string }).Text;
    }
    if (Date.now() > deadline) throw new Error(`No email to ${to} about "${subject}"`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The app link in an email, as a path on the api (the web app forwards `/api/auth/*`). */
function linkIn(text: string): string {
  const url = new RegExp(`${ORIGIN}(/api/auth/\\S+)`).exec(text)?.[1];
  if (url === undefined) throw new Error(`No link in: ${text}`);
  return url;
}

/** Opens the email check sent to `email` in `b`, which signs it in (S44, AC-W1-5). */
async function confirmEmail(b: Browser, email: string): Promise<void> {
  const link = linkIn(await emailTo(email, 'Confirm your email'));
  await b.get(link).expect(302);
}

/** Creates an account in `b` and confirms its email, so `b` is signed in. */
async function register(b: Browser, name: string, email: string): Promise<void> {
  await b.post('/api/auth/sign-up/email', { name, email, password: PASSWORD }).expect(200);
  await confirmEmail(b, email);
}

async function signUp(name: string): Promise<{ browser: Browser; email: string }> {
  const b = browser();
  const email = newEmail(name);
  await register(b, name, email);
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

  it('signs up, confirms her email by its link, and gets a session cookie scripts cannot read', async () => {
    const b = browser();
    anaEmail = newEmail('ana');
    await b
      .post('/api/auth/sign-up/email', { name: 'Ana Reyes', email: anaEmail, password: PASSWORD })
      .expect(200);
    // AC-W1-5: no session before the email is confirmed.
    await b.get('/v1/me').expect(401);
    const text = await emailTo(anaEmail, 'Confirm your email for Pepper');
    expect(text).toContain('Hi Ana,');
    const response = await b.get(linkIn(text)).expect(302);
    const cookies = ([] as string[]).concat(response.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('pepper.session_token='));
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
  it('stores emails lowercased; a second sign-up answers the same and emails the owner instead', async () => {
    const b = browser();
    const email = newEmail('Casey').replace('casey', 'Casey');
    await register(b, 'Casey', email);
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
    expect(row?.email).toBe(email.toLowerCase());
    const again = browser();
    // No account oracle (ADR-0012's gap, closed in S44): the same answer as a new address.
    await again
      .post('/api/auth/sign-up/email', {
        name: 'Casey 2',
        email: email.toLowerCase(),
        password: 'another long password',
      })
      .expect(200);
    await again.get('/v1/me').expect(401);
    expect(await emailTo(email.toLowerCase(), 'You already have a Pepper account')).toContain(
      `${ORIGIN}/sign-in`,
    );
    expect(await db.select().from(users).where(eq(users.email, email.toLowerCase()))).toHaveLength(
      1,
    );
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
    await register(jess, 'Jess', email);
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
    await register(marco, 'Marco', email);
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
    await register(staffer, 'Staffer', email);
    await staffer.post('/v1/invites/accept', { token }).expect(200);
    const asStaff = await staffer.post('/v1/invites', { email: newEmail('x'), role: 'staff' });
    expect([asStaff.status, errorCode(asStaff.body)]).toEqual([403, 'forbidden']);
    expect(errorCode((await staffer.get('/v1/invites').expect(403)).body)).toBe('forbidden');

    const managerEmail = newEmail('mgr');
    const { token: managerToken } = await invite(ana, managerEmail, 'manager');
    const manager = browser();
    await register(manager, 'Mgr', managerEmail);
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

describe('appointments base data (ADR-0015)', () => {
  let ana: Browser;
  let cara: Browser;
  let dev: Browser;
  let ids: { ana: string; cara: string };
  let tenantId: string;

  beforeAll(async () => {
    ({ browser: ana } = await signUp('ana'));
    ({ browser: cara } = await signUp('cara'));
    ({ browser: dev } = await signUp('dev'));
    ids = { ana: (await me(ana)).user.id, cara: (await me(cara)).user.id };
    tenantId = (
      (await ana.post('/v1/tenants', { ...juniper, slug: 'appointments-salon' }).expect(201))
        .body as { id: string }
    ).id;
    await enrolTotp(ana);
    await withTenant(db, TenantIdSchema.parse(tenantId), (tx) =>
      addMembership(tx, { userId: UserIdSchema.parse(ids.cara), role: 'staff' }),
    );
    await cara.put('/v1/me/active-tenant', { tenantId }).expect(204);
    // Dev runs another business.
    await dev.post('/v1/tenants', { ...juniper, slug: 'other-salon' }).expect(201);
    await enrolTotp(dev);
  });

  it('the owner sets up a service, a staff member linked to Cara, and her week', async () => {
    const service = ServiceSchema.parse(
      (
        await ana
          .post('/v1/services', {
            name: "Women's haircut",
            durationMinutes: 60,
            bufferAfterMinutes: 10,
            priceFromCents: 4000,
            priceToCents: 6500,
          })
          .expect(201)
      ).body,
    );
    const staff = StaffMemberSchema.parse(
      (
        await ana
          .post('/v1/staff', { displayName: 'Cara', userId: ids.cara, serviceIds: [service.id] })
          .expect(201)
      ).body,
    );
    const week = WeeklyHoursSchema.parse(
      (
        await ana
          .put(`/v1/staff/${staff.id}/hours`, {
            intervals: [
              { weekday: 2, start: '09:00', end: '17:00' },
              { weekday: 6, start: '10:00', end: '14:00' },
            ],
          })
          .expect(200)
      ).body,
    );
    expect(week.intervals).toHaveLength(2);

    // Staff read the menu, the team and the hours.
    expect((await cara.get('/v1/services').expect(200)).body).toEqual({ services: [service] });
    const team = StaffResponseSchema.parse((await cara.get('/v1/staff').expect(200)).body);
    expect(team.staff).toEqual([staff]);
    expect((await cara.get(`/v1/staff/${staff.id}/hours`).expect(200)).body).toEqual(week);
  });

  it('Cara adds and removes her own time off, but cannot change her hours or the menu', async () => {
    const [staff] = StaffResponseSchema.parse((await cara.get('/v1/staff').expect(200)).body).staff;
    if (staff === undefined) throw new Error('no staff member');
    const span = { startsAt: '2030-01-07T14:00:00.000Z', endsAt: '2030-01-07T18:00:00.000Z' };
    const entry = TimeOffSchema.parse(
      (await cara.post(`/v1/staff/${staff.id}/time-off`, span).expect(201)).body,
    );
    expect(
      TimeOffResponseSchema.parse(
        (await ana.get(`/v1/staff/${staff.id}/time-off`).expect(200)).body,
      ).timeOff,
    ).toEqual([entry]);
    await cara.delete(`/v1/staff/${staff.id}/time-off/${entry.id}`).expect(204);

    const hours = await cara.put(`/v1/staff/${staff.id}/hours`, { intervals: [] }).expect(403);
    expect(errorCode(hours.body)).toBe('forbidden');
    await cara.post('/v1/services', { name: 'Free', durationMinutes: 5 }).expect(403);
  });

  it("Cara cannot manage a colleague's time off", async () => {
    const marco = StaffMemberSchema.parse(
      (await ana.post('/v1/staff', { displayName: 'Marco' }).expect(201)).body,
    );
    const span = { startsAt: '2030-01-08T14:00:00.000Z', endsAt: '2030-01-08T18:00:00.000Z' };
    const denied = await cara.post(`/v1/staff/${marco.id}/time-off`, span).expect(403);
    expect(errorCode(denied.body)).toBe('forbidden');
    const ofMarco = TimeOffSchema.parse(
      (await ana.post(`/v1/staff/${marco.id}/time-off`, span).expect(201)).body,
    );
    await cara.delete(`/v1/staff/${marco.id}/time-off/${ofMarco.id}`).expect(403);
  });

  it('the owner sets booking rules; Cara reads them but cannot change them', async () => {
    const [staff] = StaffResponseSchema.parse((await ana.get('/v1/staff').expect(200)).body).staff;
    const staffId = staff?.id ?? '';
    const rules = BookingRulesResponseSchema.parse(
      (
        await ana
          .put('/v1/rules', {
            rules: [
              { type: 'minimum_notice', staffMemberId: staffId, params: { minutes: 0 } },
              { type: 'minimum_notice', params: { minutes: 1440 } },
              {
                type: 'blackout_window',
                params: { startDate: '2030-12-25', endDate: '2030-12-26' },
              },
            ],
          })
          .expect(200)
      ).body,
    );
    expect(rules.rules.map((r) => [r.staffMemberId, r.type])).toEqual([
      [null, 'minimum_notice'],
      [null, 'blackout_window'],
      [staffId, 'minimum_notice'],
    ]);
    expect((await cara.get('/v1/rules').expect(200)).body).toEqual(rules);
    const denied = await cara.put('/v1/rules', { rules: [] }).expect(403);
    expect(errorCode(denied.body)).toBe('forbidden');
    const invalid = await ana.put('/v1/rules', {
      rules: [{ type: 'slot_interval', params: { minutes: 7 } }],
    });
    expect([invalid.status, errorCode(invalid.body)]).toEqual([400, 'validation_failed']);
  });

  it("another business's owner finds none of it (AC-X-1)", async () => {
    const [staff] = StaffResponseSchema.parse((await ana.get('/v1/staff').expect(200)).body).staff;
    const services = (await ana.get('/v1/services').expect(200)).body as {
      services: { id: string }[];
    };
    const serviceId = services.services[0]?.id ?? '';
    const staffId = staff?.id ?? '';
    expect((await dev.get('/v1/services').expect(200)).body).toEqual({ services: [] });
    expect((await dev.get('/v1/staff').expect(200)).body).toEqual({ staff: [] });
    const probes = [
      await dev.get(`/v1/staff/${staffId}/hours`),
      await dev.put(`/v1/staff/${staffId}`, { displayName: 'Stolen' }),
      await dev.put(`/v1/staff/${staffId}/hours`, { intervals: [] }),
      await dev.post(`/v1/staff/${staffId}/time-off`, {
        startsAt: '2030-01-07T14:00:00.000Z',
        endsAt: '2030-01-07T18:00:00.000Z',
      }),
      await dev.put(`/v1/services/${serviceId}`, { name: 'Stolen', durationMinutes: 30 }),
      await dev.put('/v1/rules', {
        rules: [{ type: 'minimum_notice', staffMemberId: staffId, params: { minutes: 0 } }],
      }),
    ];
    expect(probes.map((r) => [r.status, errorCode(r.body)])).toEqual([
      [404, 'staff_member_not_found'],
      [404, 'staff_member_not_found'],
      [404, 'staff_member_not_found'],
      [404, 'staff_member_not_found'],
      [404, 'service_not_found'],
      [404, 'staff_member_not_found'],
    ]);
    expect((await dev.get('/v1/rules').expect(200)).body).toEqual({
      rules: [],
      defaults: PLATFORM_RULE_DEFAULTS,
    });
    // Nor can Dev offer Ana's service or link Ana's staff login.
    const offered = await dev.post('/v1/staff', { displayName: 'X', serviceIds: [serviceId] });
    expect([offered.status, errorCode(offered.body)]).toEqual([404, 'service_not_found']);
    const linked = await dev.post('/v1/staff', { displayName: 'X', userId: ids.cara });
    expect([linked.status, errorCode(linked.body)]).toEqual([404, 'member_not_found']);
  });

  it('every change is in the audit log, without staff names', async () => {
    const log = AuditLogResponseSchema.parse(
      (await ana.get('/v1/audit-log?limit=100').expect(200)).body,
    );
    const actions = log.entries.map((e) => e.action);
    for (const action of [
      'service.created',
      'staff_member.created',
      'working_hours.replaced',
      'time_off.created',
      'time_off.deleted',
      'booking_rules.replaced',
    ]) {
      expect(actions).toContain(action);
    }
    expect(JSON.stringify(log)).not.toContain('Marco');
  });
});

describe('clients, bookings and the waitlist (ADR-0017)', () => {
  let ana: Browser;
  let cara: Browser;
  let dev: Browser;
  let ids: { cara: string };
  let tenantId: string;
  let service: Service;
  let caraStaff: StaffMember;
  let marco: StaffMember;
  let maria: Client;
  let lee: Client;
  /** `HH:MM` in New York three days from now (local time, any weekday: Juniper is open daily). */
  let date: string;
  let at: (time: string) => string;
  let day: { from: string; to: string };

  beforeAll(async () => {
    ({ browser: ana } = await signUp('ana'));
    ({ browser: cara } = await signUp('cara'));
    ({ browser: dev } = await signUp('dev'));
    ids = { cara: (await me(cara)).user.id };
    tenantId = (
      (await ana.post('/v1/tenants', { ...juniper, slug: 'bookings-salon' }).expect(201)).body as {
        id: string;
      }
    ).id;
    await enrolTotp(ana);
    await withTenant(db, TenantIdSchema.parse(tenantId), (tx) =>
      addMembership(tx, { userId: UserIdSchema.parse(ids.cara), role: 'staff' }),
    );
    await cara.put('/v1/me/active-tenant', { tenantId }).expect(204);
    await dev.post('/v1/tenants', { ...juniper, slug: 'other-bookings-salon' }).expect(201);
    await enrolTotp(dev);

    service = ServiceSchema.parse(
      (
        await ana
          .post('/v1/services', { name: 'Haircut', durationMinutes: 60, bufferAfterMinutes: 10 })
          .expect(201)
      ).body,
    );
    const staff = (displayName: string, userId: string | null) =>
      ana
        .post('/v1/staff', { displayName, userId, serviceIds: [service.id] })
        .expect(201)
        .then((r) => StaffMemberSchema.parse(r.body));
    caraStaff = await staff('Cara', ids.cara);
    marco = await staff('Marco', null);
    const week = {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '08:00',
        end: '20:00',
      })),
    };
    for (const s of [caraStaff, marco]) {
      await ana.put(`/v1/staff/${s.id}/hours`, week).expect(200);
    }
    date = formatDate(addDays(toZoned('America/New_York', Date.now()), 3));
    at = (time: string) =>
      new Date(fromZoned('America/New_York', parseDate(date), minutesOfDay(time))).toISOString();
    day = { from: at('00:00'), to: at('23:59') };
  });

  it('owners add clients; staff cannot, and see only the clients they have bookings with', async () => {
    maria = ClientSchema.parse(
      (
        await ana
          .post('/v1/clients', { name: 'Maria Lopez', email: 'maria@example.test' })
          .expect(201)
      ).body,
    );
    lee = ClientSchema.parse((await ana.post('/v1/clients', { name: 'Lee' }).expect(201)).body);
    expect(errorCode((await cara.post('/v1/clients', { name: 'Walk-in' }).expect(403)).body)).toBe(
      'forbidden',
    );
    const taken = await ana.post('/v1/clients', { name: 'M', email: 'MARIA@example.test' });
    expect([taken.status, errorCode(taken.body)]).toEqual([409, 'client_email_taken']);
    expect((await cara.get('/v1/clients').expect(200)).body).toEqual({
      clients: [],
      nextCursor: null,
    });
    expect(errorCode((await cara.get(`/v1/clients/${maria.id}`).expect(404)).body)).toBe(
      'client_not_found',
    );
  });

  it('AC-W9-1: Cara sees and changes only her own bookings; everyone sees busy times', async () => {
    const hers = BookingSchema.parse(
      (
        await ana
          .post('/v1/bookings', {
            clientId: maria.id,
            serviceId: service.id,
            staffMemberId: caraStaff.id,
            startsAt: at('10:00'),
          })
          .expect(201)
      ).body,
    );
    const marcos = BookingSchema.parse(
      (
        await ana
          .post('/v1/bookings', {
            clientId: lee.id,
            serviceId: service.id,
            staffMemberId: marco.id,
            startsAt: at('10:00'),
          })
          .expect(201)
      ).body,
    );
    const query = `from=${day.from}&to=${day.to}`;
    expect(
      BookingsResponseSchema.parse((await cara.get(`/v1/bookings?${query}`).expect(200)).body)
        .bookings,
    ).toEqual([hers]);
    expect(
      BookingsResponseSchema.parse((await ana.get(`/v1/bookings?${query}`).expect(200)).body)
        .bookings,
    ).toHaveLength(2);
    expect(
      ClientsResponseSchema.parse((await cara.get('/v1/clients').expect(200)).body).clients,
    ).toEqual([maria]);

    const probes = [
      await cara.get(`/v1/bookings/${marcos.id}`),
      await cara.patch(`/v1/bookings/${marcos.id}`, { status: 'cancelled' }),
    ];
    expect(probes.map((r) => [r.status, errorCode(r.body)])).toEqual([
      [404, 'booking_not_found'],
      [404, 'booking_not_found'],
    ]);
    const forMarco = await cara.post('/v1/bookings', {
      clientId: maria.id,
      serviceId: service.id,
      staffMemberId: marco.id,
      startsAt: at('14:00'),
    });
    expect([forMarco.status, errorCode(forMarco.body)]).toEqual([403, 'forbidden']);

    const busy = BusyResponseSchema.parse(
      (await cara.get(`/v1/calendar/busy?${query}`).expect(200)).body,
    );
    expect(busy.busy.map((b) => b.staffMemberId).sort()).toEqual([caraStaff.id, marco.id].sort());
    expect(JSON.stringify(busy)).not.toContain(lee.id);
  });

  it('AC-W2-1: a taken time is refused with the 3 nearest free times', async () => {
    const refused = await ana
      .post('/v1/bookings', {
        clientId: maria.id,
        serviceId: service.id,
        staffMemberId: caraStaff.id,
        startsAt: at('10:30'),
      })
      .expect(409);
    const body = SlotUnavailableSchema.parse(refused.body);
    // Her 10:00 haircut occupies 10:00–11:10; slots are every 15 minutes.
    expect(body.alternatives.map((a) => a.startsAt)).toEqual([
      at('11:15'),
      at('11:30'),
      at('11:45'),
    ]);
    const slots = AvailabilityResponseSchema.parse(
      (
        await cara
          .get(
            `/v1/availability?serviceId=${service.id}&staffMemberId=${caraStaff.id}&${new URLSearchParams(day).toString()}`,
          )
          .expect(200)
      ).body,
    ).slots;
    for (const alternative of body.alternatives) expect(slots).toContainEqual(alternative);
  });

  it('Cara moves and cancels her booking; the time is then free again', async () => {
    const query = `from=${day.from}&to=${day.to}&staffMemberId=${caraStaff.id}`;
    const [hers] = BookingsResponseSchema.parse(
      (await cara.get(`/v1/bookings?${query}`).expect(200)).body,
    ).bookings;
    if (hers === undefined) throw new Error('no booking');
    const moved = BookingSchema.parse(
      (await cara.patch(`/v1/bookings/${hers.id}`, { startsAt: at('12:00') }).expect(200)).body,
    );
    expect(moved.startsAt).toBe(at('12:00'));
    const cancelled = BookingSchema.parse(
      (await cara.patch(`/v1/bookings/${hers.id}`, { status: 'cancelled' }).expect(200)).body,
    );
    expect(cancelled.status).toBe('cancelled');
    const again = await cara.patch(`/v1/bookings/${hers.id}`, { status: 'no_show' });
    expect([again.status, errorCode(again.body)]).toEqual([409, 'booking_not_changeable']);
    await ana
      .post('/v1/bookings', {
        clientId: maria.id,
        serviceId: service.id,
        staffMemberId: caraStaff.id,
        startsAt: at('12:00'),
      })
      .expect(201);
  });

  it('the waitlist: Cara sees and cancels only entries for her', async () => {
    const windows = [{ date, start: '09:00', end: '12:00' }];
    // A morning with free times is refused with them (AC-W5-2)…
    const free = await ana.post('/v1/waitlist', {
      clientId: lee.id,
      serviceId: service.id,
      windows,
    });
    expect([free.status, errorCode(free.body)]).toEqual([409, 'waitlist_times_free']);
    const times = WaitlistTimesFreeSchema.parse(free.body).alternatives.map((s) => s.startsAt);
    expect(times).toHaveLength(3);
    expect(times.every((t) => t >= at('09:00') && t < at('12:00'))).toBe(true);
    // …so the morning is made full (both off) while they join, and opened again after.
    const morning = { startsAt: at('09:00'), endsAt: at('12:00') };
    const off = [];
    for (const s of [caraStaff, marco]) {
      const entry = TimeOffSchema.parse(
        (await ana.post(`/v1/staff/${s.id}/time-off`, morning).expect(201)).body,
      );
      off.push(`/v1/staff/${s.id}/time-off/${entry.id}`);
    }
    const anyone = WaitlistEntrySchema.parse(
      (
        await ana
          .post('/v1/waitlist', { clientId: lee.id, serviceId: service.id, windows })
          .expect(201)
      ).body,
    );
    expect(anyone).toMatchObject({
      status: 'waiting',
      staffMemberId: null,
      expiresAt: at('12:00'),
    });
    const hers = WaitlistEntrySchema.parse(
      (
        await cara
          .post('/v1/waitlist', {
            clientId: maria.id,
            serviceId: service.id,
            staffMemberId: caraStaff.id,
            windows,
          })
          .expect(201)
      ).body,
    );
    expect(
      WaitlistResponseSchema.parse((await cara.get('/v1/waitlist').expect(200)).body).entries,
    ).toEqual([hers]);
    expect(
      WaitlistResponseSchema.parse((await ana.get('/v1/waitlist').expect(200)).body).entries,
    ).toEqual([anyone, hers]);
    for (const path of off) await ana.delete(path).expect(204);
    const notHers = await cara.patch(`/v1/waitlist/${anyone.id}`, { status: 'cancelled' });
    expect([notHers.status, errorCode(notHers.body)]).toEqual([404, 'waitlist_entry_not_found']);
    await cara.patch(`/v1/waitlist/${hers.id}`, { status: 'cancelled' }).expect(200);
  });

  it("another business's owner finds none of it (AC-X-1)", async () => {
    const query = `from=${day.from}&to=${day.to}`;
    expect((await dev.get(`/v1/bookings?${query}`).expect(200)).body).toEqual({
      bookings: [],
      truncated: false,
    });
    expect((await dev.get(`/v1/calendar/busy?${query}`).expect(200)).body).toEqual({
      busy: [],
      truncated: false,
    });
    expect((await dev.get('/v1/clients').expect(200)).body).toEqual({
      clients: [],
      nextCursor: null,
    });
    expect((await dev.get('/v1/waitlist?all=true').expect(200)).body).toEqual({ entries: [] });
    const probes = [
      await dev.get(`/v1/clients/${maria.id}`),
      await dev.post('/v1/bookings', {
        clientId: maria.id,
        serviceId: service.id,
        staffMemberId: caraStaff.id,
        startsAt: at('16:00'),
      }),
      await dev.get(`/v1/availability?serviceId=${service.id}&${query}`),
    ];
    expect(probes.map((r) => [r.status, errorCode(r.body)])).toEqual([
      [404, 'client_not_found'],
      [404, 'staff_member_not_found'],
      [404, 'service_not_found'],
    ]);
  });

  it('every change is audited without client details, and no client data is logged', async () => {
    const log = AuditLogResponseSchema.parse(
      (await ana.get('/v1/audit-log?limit=100').expect(200)).body,
    );
    const actions = log.entries.map((e) => e.action);
    for (const action of [
      'client.created',
      'booking.created',
      'booking.updated',
      'waitlist_entry.created',
      'waitlist_entry.updated',
    ]) {
      expect(actions).toContain(action);
    }
    const logged = JSON.stringify(log) + JSON.stringify(logLines);
    for (const personal of ['Maria Lopez', 'maria@example.test']) {
      expect(logged).not.toContain(personal);
    }
  });
});

describe('industry templates (ADR-0018)', () => {
  let bo: Browser;
  let service: Service;
  let trainer: StaffMember;
  let client: Client;
  let at: (time: string) => string;
  let day: { from: string; to: string };

  beforeAll(async () => {
    ({ browser: bo } = await signUp('bo'));
  });

  it('a new owner sees the eight business types before having a business', async () => {
    const { templates } = TemplatesResponseSchema.parse(
      (await bo.get('/v1/templates').expect(200)).body,
    );
    expect([...templates.map((t) => t.id)].sort()).toEqual([...TemplateIdSchema.options].sort());
    expect(templates.filter((t) => t.featured)).toHaveLength(4);
    expect(templates.find((t) => t.id === 'spa')?.terminology.client.singular).toBe('guest');
  });

  it('refuses an unknown business type', async () => {
    const response = await bo
      .post('/v1/tenants', { ...juniper, slug: 'bo-florist', templateId: 'florist' })
      .expect(400);
    expect(response.body).toMatchObject({ fields: ['templateId'] });
  });

  it('creates a training business from the personal-trainer template; the business shows it', async () => {
    const created = await bo
      .post('/v1/tenants', {
        name: 'Bo’s Training',
        slug: 'bos-training',
        timeZone: 'America/Chicago',
        templateId: 'personal-trainer',
      })
      .expect(201);
    expect(created.body).toMatchObject({ templateId: 'personal-trainer' });
    await enrolTotp(bo);
    const current = CurrentBusinessResponseSchema.parse(
      (await bo.get('/v1/tenant').expect(200)).body,
    );
    expect(current.business.templateId).toBe('personal-trainer');
  });

  it("books on the template's 30-minute grid while the business has no rules of its own", async () => {
    service = ServiceSchema.parse(
      (
        await bo
          .post('/v1/services', { name: 'Personal training', durationMinutes: 30 })
          .expect(201)
      ).body,
    );
    trainer = StaffMemberSchema.parse(
      (await bo.post('/v1/staff', { displayName: 'Bo', serviceIds: [service.id] }).expect(201))
        .body,
    );
    const week = {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
    };
    await bo.put(`/v1/staff/${trainer.id}/hours`, week).expect(200);
    client = ClientSchema.parse((await bo.post('/v1/clients', { name: 'Sam' }).expect(201)).body);
    const date = formatDate(addDays(toZoned('America/Chicago', Date.now()), 3));
    at = (time: string) =>
      new Date(fromZoned('America/Chicago', parseDate(date), minutesOfDay(time))).toISOString();
    day = { from: at('00:00'), to: at('23:59') };

    const { slots } = AvailabilityResponseSchema.parse(
      (
        await bo
          .get(`/v1/availability?serviceId=${service.id}&${new URLSearchParams(day).toString()}`)
          .expect(200)
      ).body,
    );
    expect(slots.slice(0, 3).map((s) => s.startsAt)).toEqual([
      at('09:00'),
      at('09:30'),
      at('10:00'),
    ]);
    // The rules screen shows these defaults (S16): the template's, the platform's daily cap.
    expect((await bo.get('/v1/rules').expect(200)).body).toEqual({
      rules: [],
      defaults: {
        slotIntervalMinutes: 30,
        minimumNoticeMinutes: 720,
        maximumAdvanceDays: 60,
        maxBookingsPerDay: null,
      },
    });

    const booking = { clientId: client.id, serviceId: service.id, staffMemberId: trainer.id };
    const refused = await bo
      .post('/v1/bookings', { ...booking, startsAt: at('10:15') })
      .expect(409);
    expect(SlotUnavailableSchema.parse(refused.body).alternatives.map((a) => a.startsAt)).toEqual([
      at('10:00'),
      at('10:30'),
      at('09:30'),
    ]);
    await bo.post('/v1/bookings', { ...booking, startsAt: at('10:30') }).expect(201);
  });

  it("the business's own rule then wins over the template", async () => {
    await bo
      .put('/v1/rules', { rules: [{ type: 'slot_interval', params: { minutes: 15 } }] })
      .expect(200);
    const { slots } = AvailabilityResponseSchema.parse(
      (
        await bo
          .get(`/v1/availability?serviceId=${service.id}&${new URLSearchParams(day).toString()}`)
          .expect(200)
      ).body,
    );
    expect(slots.slice(0, 3).map((s) => s.startsAt)).toEqual([
      at('09:00'),
      at('09:15'),
      at('09:30'),
    ]);
  });
});

describe('activation events (S45, ADR-0046)', () => {
  it('AC-W1-10: records the sign-up, the business and its first bookable state, ids and times only', async () => {
    const { browser: eve, email } = await signUp('eve');
    const [account] = await db.select().from(users).where(eq(users.email, email));
    if (account === undefined) throw new Error('no account');
    const signups = await db
      .select()
      .from(signupEvents)
      .where(eq(signupEvents.accountId, account.id));
    expect(signups).toHaveLength(1);
    expect(Object.keys(signups[0] ?? {}).sort()).toEqual(['accountId', 'id', 'occurredAt']);

    const created = await eve
      .post('/v1/tenants', {
        name: 'Eve’s Barbers',
        slug: 'eves-barbers',
        timeZone: 'America/Chicago',
        templateId: 'barber',
      })
      .expect(201);
    const tenantId = TenantIdSchema.parse((created.body as { id: string }).id);
    const events = await withTenant(db, tenantId, (tx) =>
      tx.select().from(activationEvents).orderBy(activationEvents.kind),
    );
    expect(events.map((e) => [e.kind, e.accountId])).toEqual([
      ['bookable', null],
      ['business_created', account.id],
    ]);
    expect(Object.keys(events[0] ?? {}).sort()).toEqual([
      'accountId',
      'id',
      'kind',
      'occurredAt',
      'tenantId',
    ]);
  });
});

describe('account recovery and email (S44, ADR-0045)', () => {
  it('AC-W1-5: an unconfirmed sign-in is refused and sends a fresh link; "Send again" tells no one apart', async () => {
    const b = browser();
    const email = newEmail('lena');
    await b.post('/api/auth/sign-up/email', { name: 'Lena', email, password: PASSWORD });
    const refused = await b.post('/api/auth/sign-in/email', { email, password: PASSWORD });
    expect([refused.status, (refused.body as { code?: string }).code]).toEqual([
      403,
      'EMAIL_NOT_VERIFIED',
    ]);
    await b.get('/v1/me').expect(401);
    // The same answer for an address without an account.
    for (const asked of [email, newEmail('nobody')]) {
      await browser()
        .post('/api/auth/send-verification-email', { email: asked, callbackURL: '/' })
        .expect(200);
    }
    expect(await inbox(newEmail('nobody'))).toEqual([]);
    await confirmEmail(b, email);
    expect((await me(b)).user).toMatchObject({ email });
  });

  it('AC-W1-4: a reset answers the same for any address, works once, and signs out every other session', async () => {
    const { browser: phone, email } = await signUp('rosa');
    const laptop = browser();
    await laptop.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
    const asker = browser();
    for (const asked of [email, newEmail('nobody')]) {
      const answer = await asker
        .post('/api/auth/request-password-reset', { email: asked, redirectTo: '/reset-password' })
        .expect(200);
      expect(answer.body).toMatchObject({ status: true });
    }
    const text = await emailTo(email, 'Reset your Pepper password');
    expect(text).toContain('It works once, for 60 minutes.');
    // The link checks the token and sends the browser to the page with it.
    const opened = await asker.get(linkIn(text)).expect(302);
    const location = new URL(String(opened.headers['location']), ORIGIN);
    expect(location.pathname).toBe('/reset-password');
    const token = location.searchParams.get('token');
    expect(token).toBeTruthy();

    const newPassword = 'a brand new passphrase';
    await asker.post('/api/auth/reset-password', { token, newPassword }).expect(200);
    await phone.get('/v1/me').expect(401);
    await laptop.get('/v1/me').expect(401);
    const again = await asker.post('/api/auth/reset-password', {
      token,
      newPassword: 'x'.repeat(12),
    });
    expect(again.status).toBe(400);
    await browser().post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(401);
    await browser().post('/api/auth/sign-in/email', { email, password: newPassword }).expect(200);
  });

  it('AC-W1-6: a new email counts only once the current address, then the new one, confirm', async () => {
    const { browser: b, email } = await signUp('nora');
    const newAddress = newEmail('nora.new');
    await b
      .post('/api/auth/change-email', { newEmail: newAddress, callbackURL: '/email-confirmed' })
      .expect(200);
    // The current address confirms first: a stolen session alone can't move the account.
    const confirm = await emailTo(email, 'Confirm the change of your Pepper email');
    expect(confirm).toContain(newAddress);
    expect(await inbox(newAddress)).toEqual([]);
    const first = await browser().get(linkIn(confirm)).expect(302);
    expect(first.headers['location']).toBe('/email-confirmed?changed=pending');
    expect((await me(b)).user.email).toBe(email);

    const text = await emailTo(newAddress, 'Confirm your new email for Pepper');
    // Nothing changed yet: the old address still signs in, the new one doesn't.
    expect((await me(b)).user.email).toBe(email);
    await browser()
      .post('/api/auth/sign-in/email', { email: newAddress, password: PASSWORD })
      .expect(401);

    const second = await b.get(linkIn(text)).expect(302);
    expect(second.headers['location']).toBe('/email-confirmed?changed=1');
    expect((await me(b)).user.email).toBe(newAddress);
    await browser().post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(401);
    await browser()
      .post('/api/auth/sign-in/email', { email: newAddress, password: PASSWORD })
      .expect(200);
  });

  it('AC-W1-43 (L15): a finished change of email ends every other session', async () => {
    const { browser: phone, email } = await signUp('opal');
    const laptop = browser();
    await laptop.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
    const tablet = browser();
    await tablet.post('/api/auth/sign-in/email', { email, password: PASSWORD }).expect(200);
    const newAddress = newEmail('opal.new');
    await phone
      .post('/api/auth/change-email', { newEmail: newAddress, callbackURL: '/email-confirmed' })
      .expect(200);
    await browser()
      .get(linkIn(await emailTo(email, 'Confirm the change of your Pepper email')))
      .expect(302);
    // Only the current address has confirmed: nothing ends yet.
    await laptop.get('/v1/me').expect(200);
    await phone
      .get(linkIn(await emailTo(newAddress, 'Confirm your new email for Pepper')))
      .expect(302);
    expect((await me(phone)).user.email).toBe(newAddress);
    await laptop.get('/v1/me').expect(401);
    await tablet.get('/v1/me').expect(401);
  });

  it('a change to an address that has an account answers the same and changes nothing', async () => {
    const { browser: b, email } = await signUp('ivy');
    const { email: taken } = await signUp('ivy.taken');
    await b
      .post('/api/auth/change-email', { newEmail: taken, callbackURL: '/account' })
      .expect(200);
    expect((await inbox(taken)).map((m) => m.Subject)).not.toContain(
      'Confirm your new email for Pepper',
    );
    expect((await inbox(email)).map((m) => m.Subject)).not.toContain(
      'Confirm the change of your Pepper email',
    );
    expect((await me(b)).user.email).toBe(email);
  });

  it('sends no address or link token to the logs (the reset path is logged as :token)', () => {
    const leaked = logLines
      .map((line) => JSON.stringify(line))
      .filter((line) => /verify-email\?token|reset-password\/(?!:token)|@example\.test/.test(line));
    expect(leaked).toEqual([]);
  });
});
