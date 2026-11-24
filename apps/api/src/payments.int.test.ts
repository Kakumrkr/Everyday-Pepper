import 'reflect-metadata';
import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import {
  PaymentAccountAnswerSchema,
  PaymentOnboardingLinkSchema,
  TenantIdSchema,
  UserIdSchema,
} from '@pepper/contracts';
import {
  addMembership,
  findPaymentAccount,
  findPaymentWebhookEvent,
  listAuditEntries,
  newId,
  prepareDatabase,
  withPaymentsWebhook,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
import { stripeSignature, stripeSignatureHeader } from '@pepper/payments';
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// Payments through the api against real Postgres and Redis (S65, ADR-0067, AC-X-96…104): the
// whole app as configured from its environment, twice: with Stripe (its API answered in this
// process from its documented shapes, so the webhook's real signature check runs with a known
// secret) and with the sandbox (its dev route delivering signed events through the same path).

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct horse battery staple';
const SECRET = 'whsec_5f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e';
const KEY = 'sk_test_51NvApiIntegrationTestKey00000';

let postgres: TestService;
let redis: TestService;
let stripeApp: INestApplication;
let sandboxApp: INestApplication;
let stripeServer: Server;
let sandboxServer: Server;
let database: DatabaseHandle;

/** Stripe's accounts as this test's "Stripe" holds them, and the calls that reached it. */
const accounts = new Map<string, Record<string, unknown>>();
const stripeCalls: { method: string; path: string; idempotencyKey: string | null }[] = [];
let accountCounter = 0;
/** Accounts whose reads fail as Stripe's own trouble would (503). */
const failing = new Set<string>();
const realFetch = globalThis.fetch;

function stripeAccount(id: string, state: 'new' | 'ready' | 'due'): Record<string, unknown> {
  const due = state === 'due' ? ['individual.verification.document'] : [];
  return {
    id,
    object: 'account',
    charges_enabled: state !== 'new',
    payouts_enabled: state === 'ready',
    details_submitted: state !== 'new',
    requirements: {
      alternatives: [],
      current_deadline: state === 'due' ? 1_798_761_600 : null,
      currently_due: state === 'new' ? ['external_account'] : due,
      disabled_reason: null,
      errors: [],
      eventually_due: state === 'new' ? ['external_account'] : due,
      past_due: [],
      pending_verification: [],
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stripe's API, answered here; any other host goes to the real fetch. */
function fakeStripe(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.host !== 'api.stripe.com') return realFetch(input, init);
  const headers = new Headers(init?.headers);
  const method = init?.method ?? 'GET';
  stripeCalls.push({ method, path: url.pathname, idempotencyKey: headers.get('idempotency-key') });
  if (headers.get('authorization') !== `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`) {
    return Promise.resolve(json(401, { error: { type: 'invalid_request_error' } }));
  }
  if (method === 'POST' && url.pathname === '/v1/accounts') {
    accountCounter += 1;
    const id = `acct_1Test${String(accountCounter).padStart(8, '0')}`;
    accounts.set(id, stripeAccount(id, 'new'));
    return Promise.resolve(json(200, accounts.get(id)));
  }
  const account = /^\/v1\/accounts\/(acct_[A-Za-z0-9]+)$/.exec(url.pathname)?.[1];
  if (method === 'GET' && account !== undefined) {
    if (failing.has(account)) return Promise.resolve(json(503, { error: { type: 'api_error' } }));
    const found = accounts.get(account);
    return Promise.resolve(
      found === undefined
        ? json(404, { error: { type: 'invalid_request_error', code: 'resource_missing' } })
        : json(200, found),
    );
  }
  if (method === 'POST' && url.pathname === '/v1/account_links') {
    return Promise.resolve(
      json(200, {
        object: 'account_link',
        created: 1_763_650_800,
        expires_at: 1_763_651_100,
        url: 'https://connect.stripe.com/setup/e/acct_1Test/abc',
      }),
    );
  }
  return Promise.resolve(json(404, { error: { type: 'invalid_request_error' } }));
}

async function startApp(env: Record<string, string>): Promise<INestApplication> {
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  const config = loadApiConfig({
    DATABASE_URL: databaseUrl,
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
  vi.stubGlobal('fetch', fakeStripe);
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  await prepareDatabase(
    postgres.url,
    postgresUrlAs(postgres.url, 'pepper_service', 'test-password'),
  );
  stripeApp = await startApp({
    PAYMENTS_PROVIDER: 'stripe',
    STRIPE_SECRET_KEY: KEY,
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_51NvApiIntegrationKey0000',
  });
  sandboxApp = await startApp({ PAYMENTS_PROVIDER: 'sandbox' });
  stripeServer = stripeApp.getHttpServer() as Server;
  sandboxServer = sandboxApp.getHttpServer() as Server;
  database = stripeApp.get<DatabaseHandle>(DATABASE);
}, 180_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([stripeApp.close(), sandboxApp.close()]);
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

/** An owner with a business and a second factor, and a staff member of it. */
async function business(server: Server) {
  const owner = await signUp(server, 'Ana Reyes');
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
  const staff = await signUp(server, 'Jess Moreno');
  await withTenant(database.db, tenantId, (tx) =>
    addMembership(tx, { userId: UserIdSchema.parse(staff.userId), role: 'staff' }),
  );
  await staff.browser.put('/v1/me/active-tenant', { tenantId }).expect(204);
  return { tenantId, owner: owner.browser, staff: staff.browser };
}

function event(account: string, type = 'account.updated', overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: `evt_1${newId().replace(/-/g, '').slice(0, 20)}`,
    object: 'event',
    api_version: '2026-11-18.endive',
    account,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object: { id: account, object: 'account', charges_enabled: true } },
    ...overrides,
  });
}

function deliver(body: string, signature: string | null) {
  const test = request(stripeServer)
    .post('/v1/webhooks/stripe')
    .set('content-type', 'application/json')
    .set('x-forwarded-for', '203.0.113.9');
  return (signature === null ? test : test.set('stripe-signature', signature)).send(body);
}

async function accountIdOf(tenantId: string): Promise<string> {
  const row = await withTenant(database.db, TenantIdSchema.parse(tenantId), (tx) =>
    findPaymentAccount(tx),
  );
  if (row === undefined) throw new Error('no account');
  return row.providerAccountId;
}

describe('payments with Stripe (AC-X-96…100)', () => {
  it('connects once for the owner, refuses staff, and reads the status', async () => {
    const b = await business(stripeServer);
    const before = PaymentAccountAnswerSchema.parse(
      (await b.owner.get('/v1/payments/account').expect(200)).body,
    );
    expect(before).toMatchObject({ status: 'not_connected', canManage: true });
    await b.staff.get('/v1/payments/account').expect(403);
    await b.staff.post('/v1/payments/onboarding').expect(403);
    // A booking's deposit (S67, AC-X-129): the team's read, not staff's; no payment reads null.
    const booking = '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a13';
    await b.staff.get(`/v1/payments/bookings/${booking}/deposit`).expect(403);
    expect(
      (await b.owner.get(`/v1/payments/bookings/${booking}/deposit`).expect(200)).body,
    ).toEqual({ deposit: null });
    await b.owner.get('/v1/payments/bookings/not-an-id/deposit').expect(400);

    const link = PaymentOnboardingLinkSchema.parse(
      (await b.owner.post('/v1/payments/onboarding').expect(200)).body,
    );
    expect(link.url).toBe('https://connect.stripe.com/setup/e/acct_1Test/abc');
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const creates = stripeCalls.filter((call) => call.path === '/v1/accounts');
    const mine = creates.filter((call) => call.idempotencyKey === `pepper-account-${b.tenantId}-1`);
    expect(mine).toHaveLength(1);
    expect((await b.owner.get('/v1/payments/account').expect(200)).body).toMatchObject({
      status: 'onboarding',
      due: ['external_account'],
    });
    // The dashboard waits for Stripe's pages.
    expect((await b.owner.post('/v1/payments/dashboard').expect(409)).body).toMatchObject({
      code: 'payments_not_onboarded',
    });
  });

  it('applies a signed event by reading the account again, once', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const account = await accountIdOf(b.tenantId);
    accounts.set(account, stripeAccount(account, 'ready'));
    const body = event(account);
    const signature = stripeSignatureHeader(SECRET, body, new Date());
    expect((await deliver(body, signature).expect(200)).body).toEqual({ received: true });
    expect((await b.owner.get('/v1/payments/account').expect(200)).body).toMatchObject({
      status: 'ready',
      chargesEnabled: true,
      payoutsEnabled: true,
    });
    // The same delivery again (Stripe's retry, or a replay within the 5 minutes): no change.
    const reads = stripeCalls.filter((call) => call.path === `/v1/accounts/${account}`).length;
    accounts.set(account, stripeAccount(account, 'due'));
    await deliver(body, signature).expect(200);
    expect(stripeCalls.filter((call) => call.path === `/v1/accounts/${account}`)).toHaveLength(
      reads,
    );
    expect(
      ((await b.owner.get('/v1/payments/account').expect(200)).body as { status: string }).status,
    ).toBe('ready');
    const entries = await withTenant(database.db, b.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 50 }),
    );
    expect(
      entries.filter((entry) => entry.action === 'payments.account_status_changed'),
    ).toHaveLength(1);
  });

  it('refuses a missing, wrong, stale or reused-for-other-bytes signature (401), changing nothing', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const account = await accountIdOf(b.tenantId);
    accounts.set(account, stripeAccount(account, 'ready'));
    const body = event(account);
    const now = Math.floor(Date.now() / 1000);
    const cases: (string | null)[] = [
      null,
      'garbage',
      `t=${String(now)},v1=${stripeSignature('whsec_another_secret_0000000000', now, body)}`,
      `t=${String(now - 301)},v1=${stripeSignature(SECRET, now - 301, body)}`,
      `t=${String(now)},v1=${stripeSignature(SECRET, now, body.replace('"livemode":false', '"livemode":true'))}`,
    ];
    for (const signature of cases) {
      const answer = await deliver(body, signature).expect(401);
      expect(answer.body).toMatchObject({ code: 'webhook_signature_invalid' });
    }
    expect(
      ((await b.owner.get('/v1/payments/account').expect(200)).body as { status: string }).status,
    ).toBe('onboarding');
    const id = (JSON.parse(body) as { id: string }).id;
    expect(
      await withPaymentsWebhook(database.db, (tx) => findPaymentWebhookEvent(tx, 'stripe', id)),
    ).toBeUndefined();
  });

  it('acknowledges events it must not act on, and refuses a body that isn’t an event (400)', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const account = await accountIdOf(b.tenantId);
    accounts.set(account, stripeAccount(account, 'ready'));
    const sign = (body: string) => stripeSignatureHeader(SECRET, body, new Date());
    for (const body of [
      event(account, 'account.updated', { livemode: true }),
      event(account, 'payout.paid'),
      event('acct_1Unknown0000'),
    ]) {
      await deliver(body, sign(body)).expect(200);
    }
    expect(
      ((await b.owner.get('/v1/payments/account').expect(200)).body as { status: string }).status,
    ).toBe('onboarding');
    const junk = JSON.stringify({ hello: 'world' });
    await deliver(junk, sign(junk)).expect(400);
  });

  it('answers 500 when Stripe can’t be read, so Stripe delivers again, then applies it', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const account = await accountIdOf(b.tenantId);
    accounts.set(account, stripeAccount(account, 'ready'));
    const body = event(account);
    const id = (JSON.parse(body) as { id: string }).id;
    failing.add(account);
    await deliver(body, stripeSignatureHeader(SECRET, body, new Date())).expect(500);
    expect(
      await withPaymentsWebhook(database.db, (tx) => findPaymentWebhookEvent(tx, 'stripe', id)),
    ).toMatchObject({ outcome: 'received' });
    failing.delete(account);
    await deliver(body, stripeSignatureHeader(SECRET, body, new Date())).expect(200);
    expect(
      ((await b.owner.get('/v1/payments/account').expect(200)).body as { status: string }).status,
    ).toBe('ready');
  });

  it('ignores for good an account Stripe won’t show (no retry storm)', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/payments/onboarding').expect(200);
    const account = await accountIdOf(b.tenantId);
    const body = event(account);
    accounts.delete(account);
    await deliver(body, stripeSignatureHeader(SECRET, body, new Date())).expect(200);
    const id = (JSON.parse(body) as { id: string }).id;
    expect(
      await withPaymentsWebhook(database.db, (tx) => findPaymentWebhookEvent(tx, 'stripe', id)),
    ).toMatchObject({ outcome: 'ignored', ignoredReason: 'unreadable_account' });
  });
});

describe('payments in the sandbox (AC-X-104)', () => {
  it('connects, then moves to each state through a signed event on the webhook’s path', async () => {
    const b = await business(sandboxServer);
    await b.owner.post('/v1/dev/payments/account', { state: 'ready' }).expect(409);
    const link = PaymentOnboardingLinkSchema.parse(
      (await b.owner.post('/v1/payments/onboarding').expect(200)).body,
    );
    expect(link.url).toBe(`${ORIGIN}/more/payments?stripe=return`);
    for (const state of ['pending', 'action_needed', 'ready'] as const) {
      const answer = PaymentAccountAnswerSchema.parse(
        (await b.owner.post('/v1/dev/payments/account', { state }).expect(200)).body,
      );
      expect(answer.status).toBe(state);
    }
    expect((await b.owner.post('/v1/payments/dashboard').expect(200)).body).toEqual({
      url: `${ORIGIN}/more/payments?sandbox=dashboard`,
    });
    const gone = PaymentAccountAnswerSchema.parse(
      (await b.owner.post('/v1/dev/payments/account', { state: 'deauthorized' }).expect(200)).body,
    );
    expect(gone.status).toBe('not_connected');
    await b.staff.post('/v1/dev/payments/account', { state: 'ready' }).expect(403);
    await b.owner.post('/v1/dev/payments/account', { state: 'sideways' }).expect(400);
  });

  it('isn’t there with Stripe (404)', async () => {
    const b = await business(stripeServer);
    await b.owner.post('/v1/dev/payments/account', { state: 'ready' }).expect(404);
    // The sandbox's card either (S66, AC-X-120).
    await b.owner
      .post('/v1/dev/payments/intent', { clientSecret: 'pi_1_secret_a', outcome: 'succeeded' })
      .expect(404);
  });
});
