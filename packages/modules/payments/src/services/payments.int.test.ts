// The payments services against real Postgres (S65, ADR-0067): onboarding once per business
// (AC-X-93), the status (AC-X-94), webhook events once each, the business only through the
// stored account, a fresh read, out-of-order reads, disconnection (AC-X-96…98), and the owners'
// push once per change (AC-X-102).
import {
  StripeAccountSchema,
  TenantIdSchema,
  type StripeAccount,
  type StripeAccountId,
  type StripeEvent,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  createBusiness,
  ForbiddenError,
  ManualClock,
  outboxKeyFrom,
  type Actor,
} from '@pepper/core';
import {
  addMembership,
  findPaymentAccount,
  findPaymentWebhookEvent,
  listAuditEntries,
  savePushSubscription,
  withPaymentsWebhook,
  withTenant,
  type Database,
} from '@pepper/db';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PaymentsNotOnboardedError, PaymentsRejectedError } from '../errors.js';
import { insertUser, startTestDatabase, type TestDatabase } from '../int-support.js';
import { PaymentsProviderError, type PaymentsProvider } from '../provider.js';
import { MemorySandboxAccountStore, SandboxPaymentsProvider, sandboxAccount } from '../sandbox.js';
import {
  paymentDashboardLink,
  readPaymentAccount,
  startPaymentOnboarding,
  syncOwnPaymentAccount,
  type PaymentsDeps,
} from './accounts.js';
import { handleStripeEvent } from './webhook.js';

let database: TestDatabase;
let db: Database;
let slugs = 0;
const START = new Date('2026-11-20T15:00:00Z');
const BASE = 'https://app.example';
const outboxKey = outboxKeyFrom('an-integration-test-outbox-secret-32+');

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

/** The sandbox, counting the calls that reach "Stripe". */
class CountingSandbox extends SandboxPaymentsProvider {
  creates = 0;
  reads = 0;
  override createAccount(input: Parameters<SandboxPaymentsProvider['createAccount']>[0]) {
    this.creates += 1;
    return super.createAccount(input);
  }
  override retrieveAccount(accountId: StripeAccountId) {
    this.reads += 1;
    return super.retrieveAccount(accountId);
  }
}

async function newBusiness(provider?: PaymentsProvider) {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Fade',
    slug: `payments-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff'): Actor => ({
    context: { tenantId, userId, role },
  });
  const member = async (role: 'owner' | 'manager' | 'staff') => {
    const userId = await insertUser(db, role);
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId, role }));
    return actor(userId, role);
  };
  const clock = new ManualClock(START);
  const sandbox = new CountingSandbox({
    store: new MemorySandboxAccountStore(),
    baseUrl: BASE,
    now: () => clock.now(),
  });
  const deps: PaymentsDeps = { db, provider: provider ?? sandbox, clock, outboxKey, baseUrl: BASE };
  return { tenantId, owner: actor(ownerId, 'owner'), member, clock, sandbox, deps };
}

let events = 0;
function event(
  type: string,
  account: string | null,
  overrides: Partial<StripeEvent> = {},
): StripeEvent {
  events += 1;
  return {
    id: `evt_${randomBytes(8).toString('hex')}${String(events)}`,
    object: 'event',
    type,
    created: Math.floor(START.getTime() / 1000),
    livemode: false,
    account,
    ...overrides,
  };
}

async function accountOf(tenantId: TenantId) {
  return withTenant(db, tenantId, (tx) => findPaymentAccount(tx));
}

async function pushesOf(tenantId: TenantId) {
  return withTenant(db, tenantId, async (tx) =>
    Number(
      (
        await tx.execute<{ n: string }>(
          `SELECT count(*) AS n FROM outbox_messages WHERE type = 'push'`,
        )
      ).rows[0]?.n,
    ),
  );
}

async function statusChanges(tenantId: TenantId) {
  const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 100 }));
  return entries
    .filter((entry) => entry.action === 'payments.account_status_changed')
    .map((entry) => [entry.before, entry.after, entry.actor.kind])
    .reverse();
}

describe('onboarding (AC-X-93)', () => {
  it('creates one account for the owner and answers Stripe’s page', async () => {
    const business = await newBusiness();
    const link = await startPaymentOnboarding(business.deps, business.owner);
    // The sandbox's page goes straight back to Pepper's return page.
    expect(link.url).toBe(`${BASE}/more/payments?stripe=return`);
    const row = await accountOf(business.tenantId);
    expect(row).toMatchObject({
      provider: 'sandbox',
      status: 'onboarding',
      generation: 1,
      livemode: false,
    });
    const entries = await withTenant(db, business.tenantId, (tx) =>
      listAuditEntries(tx, { limit: 10 }),
    );
    expect(entries.find((entry) => entry.action === 'payments.account_created')).toMatchObject({
      actor: { kind: 'user', userId: business.owner.context.userId },
      after: { provider: 'sandbox' },
    });
  });

  it('reuses the account when asked again, from another device, or twice at once', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const first = await accountOf(business.tenantId);
    await startPaymentOnboarding(business.deps, business.owner);
    expect(business.sandbox.creates).toBe(1);

    const racing = await newBusiness();
    await Promise.all([
      startPaymentOnboarding(racing.deps, racing.owner),
      startPaymentOnboarding(racing.deps, racing.owner),
      startPaymentOnboarding(racing.deps, racing.owner),
    ]);
    const stored = await accountOf(racing.tenantId);
    // Every request asked with the same idempotency key, so "Stripe" answered one account.
    expect(new Set([stored?.providerAccountId]).size).toBe(1);
    expect(stored?.generation).toBe(1);
    expect((await accountOf(business.tenantId))?.id).toBe(first?.id);
  });

  it('is the owner’s alone: managers and staff are refused', async () => {
    const business = await newBusiness();
    for (const role of ['manager', 'staff'] as const) {
      const member = await business.member(role);
      await expect(startPaymentOnboarding(business.deps, member)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(paymentDashboardLink(business.deps, member)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(syncOwnPaymentAccount(business.deps, member)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    }
    expect(await accountOf(business.tenantId)).toBeUndefined();
    // A second owner may: it is the business's account, not a person's.
    const coOwner = await business.member('owner');
    await startPaymentOnboarding(business.deps, coOwner);
    expect(await accountOf(business.tenantId)).toBeDefined();
  });

  it('gives no new page once Stripe rejected the business', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    if (row === undefined) throw new Error('no account');
    await business.sandbox.setState(row.providerAccountId, 'rejected');
    business.clock.advanceBy(1000);
    await syncOwnPaymentAccount(business.deps, business.owner);
    await expect(startPaymentOnboarding(business.deps, business.owner)).rejects.toBeInstanceOf(
      PaymentsRejectedError,
    );
  });

  it('opens the Express dashboard only once Stripe’s pages are done', async () => {
    const business = await newBusiness();
    await expect(paymentDashboardLink(business.deps, business.owner)).rejects.toBeInstanceOf(
      PaymentsNotOnboardedError,
    );
    await startPaymentOnboarding(business.deps, business.owner);
    await expect(paymentDashboardLink(business.deps, business.owner)).rejects.toBeInstanceOf(
      PaymentsNotOnboardedError,
    );
    const row = await accountOf(business.tenantId);
    await business.sandbox.setState(row?.providerAccountId ?? '', 'ready');
    business.clock.advanceBy(1000);
    await syncOwnPaymentAccount(business.deps, business.owner);
    expect((await paymentDashboardLink(business.deps, business.owner)).url).toBe(
      `${BASE}/more/payments?sandbox=dashboard`,
    );
  });
});

describe('another provider or mode (ADR-0067 §4)', () => {
  it('reads a sandbox or test account as not connected, and replaces it on connecting', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const sandboxRow = await accountOf(business.tenantId);
    // The same business on Stripe now (the sandbox's store answers as "Stripe" here).
    const stripe: PaymentsProvider = {
      provider: 'stripe',
      livemode: false,
      createAccount: (input) => business.sandbox.createAccount(input),
      retrieveAccount: (id) => business.sandbox.retrieveAccount(id),
      createOnboardingLink: (input) => business.sandbox.createOnboardingLink(input),
      createDashboardLink: (id) => business.sandbox.createDashboardLink(id),
    };
    await business.sandbox.setState(sandboxRow?.providerAccountId ?? '', 'ready');
    business.clock.advanceBy(1000);
    await syncOwnPaymentAccount(business.deps, business.owner);
    expect((await readPaymentAccount(business.deps, business.owner)).status).toBe('ready');
    const onStripe = { ...business.deps, provider: stripe };
    expect((await readPaymentAccount(onStripe, business.owner)).status).toBe('not_connected');
    await expect(paymentDashboardLink(onStripe, business.owner)).rejects.toBeInstanceOf(
      PaymentsNotOnboardedError,
    );
    // An event for the old account changes nothing.
    business.clock.advanceBy(1000);
    expect(await syncOwnPaymentAccount(onStripe, business.owner)).toMatchObject({
      status: 'not_connected',
    });
    await startPaymentOnboarding(onStripe, business.owner);
    const replaced = await accountOf(business.tenantId);
    expect(replaced).toMatchObject({ provider: 'stripe', generation: 2, status: 'onboarding' });
    expect(replaced?.providerAccountId).not.toBe(sandboxRow?.providerAccountId);
    expect(replaced?.id).toBe(sandboxRow?.id);
  });

  it('answers what Pepper knows when Stripe refuses for good to show the account', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    await business.sandbox.setState(row?.providerAccountId ?? '', 'deauthorized');
    business.clock.advanceBy(1000);
    expect(await syncOwnPaymentAccount(business.deps, business.owner)).toMatchObject({
      status: 'onboarding',
    });
  });
});

describe('status (AC-X-94)', () => {
  it('reads not_connected, then what Stripe says, to owners and managers; not to staff', async () => {
    const business = await newBusiness();
    const manager = await business.member('manager');
    const staff = await business.member('staff');
    expect(await readPaymentAccount(business.deps, manager)).toMatchObject({
      status: 'not_connected',
      canManage: false,
      syncedAt: null,
    });
    await expect(readPaymentAccount(business.deps, staff)).rejects.toBeInstanceOf(ForbiddenError);
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    await business.sandbox.setState(row?.providerAccountId ?? '', 'action_needed');
    business.clock.advanceBy(1000);
    const answer = await syncOwnPaymentAccount(business.deps, business.owner);
    expect(answer).toEqual({
      status: 'action_needed',
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      due: ['individual.verification.document'],
      eventuallyDue: ['individual.verification.document'],
      dueBy: '2026-12-04T15:00:00.000Z',
      disabledReason: null,
      syncedAt: '2026-11-20T15:00:01.000Z',
      canManage: true,
    });
    expect((await readPaymentAccount(business.deps, manager)).status).toBe('action_needed');
  });
});

describe('webhook events (AC-X-96…98)', () => {
  async function connected(state: 'pending' | 'ready' | 'action_needed' = 'pending') {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    if (row === undefined) throw new Error('no account');
    await business.sandbox.setState(row.providerAccountId, state);
    business.clock.advanceBy(1000);
    return { ...business, accountId: row.providerAccountId };
  }

  it('reads the account again and applies it, audited as Pepper, with the owners’ push', async () => {
    const business = await connected('ready');
    const ownerId = business.owner.context.userId;
    await withTenant(db, business.tenantId, (tx) =>
      savePushSubscription(tx, {
        userId: ownerId,
        endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString('hex')}`,
        p256dh: 'B'.repeat(87),
        auth: 'a'.repeat(22),
      }),
    );
    const delivered = event('account.updated', business.accountId);
    expect(await handleStripeEvent(business.deps, delivered)).toEqual({
      outcome: 'processed',
      tenantId: business.tenantId,
    });
    expect((await accountOf(business.tenantId))?.status).toBe('ready');
    expect(await statusChanges(business.tenantId)).toEqual([
      [{ status: 'onboarding' }, { status: 'ready' }, 'system'],
    ]);
    expect(await pushesOf(business.tenantId)).toBe(1);
    const stored = await withPaymentsWebhook(db, (tx) =>
      findPaymentWebhookEvent(tx, 'sandbox', delivered.id),
    );
    expect(stored).toMatchObject({
      outcome: 'processed',
      tenantId: business.tenantId,
      attempts: 1,
    });
  });

  it('handles a replayed or redelivered event once', async () => {
    const business = await connected('ready');
    const delivered = event('account.updated', business.accountId);
    await handleStripeEvent(business.deps, delivered);
    const reads = business.sandbox.reads;
    for (let i = 0; i < 3; i += 1) {
      expect(await handleStripeEvent(business.deps, delivered)).toEqual({ outcome: 'duplicate' });
    }
    expect(business.sandbox.reads).toBe(reads);
    expect(await statusChanges(business.tenantId)).toHaveLength(1);
  });

  it('handles again an event whose earlier handling failed, and only then', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    if (row === undefined) throw new Error('no account');
    let failing = true;
    const flaky: PaymentsProvider = {
      provider: 'sandbox',
      livemode: false,
      createAccount: (input) => business.sandbox.createAccount(input),
      createOnboardingLink: (input) => business.sandbox.createOnboardingLink(input),
      createDashboardLink: (id) => business.sandbox.createDashboardLink(id),
      retrieveAccount: (id) =>
        failing
          ? Promise.reject(new PaymentsProviderError(503, 'api_error', null, true))
          : business.sandbox.retrieveAccount(id),
    };
    await business.sandbox.setState(row.providerAccountId, 'ready');
    const deps = { ...business.deps, provider: flaky };
    const delivered = event('account.updated', row.providerAccountId);
    await expect(handleStripeEvent(deps, delivered)).rejects.toBeInstanceOf(PaymentsProviderError);
    expect(
      await withPaymentsWebhook(db, (tx) => findPaymentWebhookEvent(tx, 'sandbox', delivered.id)),
    ).toMatchObject({ outcome: 'received', processedAt: null });
    failing = false;
    business.clock.advanceBy(1000);
    expect(await handleStripeEvent(deps, delivered)).toMatchObject({ outcome: 'processed' });
    expect((await accountOf(business.tenantId))?.status).toBe('ready');
    expect(
      await withPaymentsWebhook(db, (tx) => findPaymentWebhookEvent(tx, 'sandbox', delivered.id)),
    ).toMatchObject({ outcome: 'processed', attempts: 2 });
    expect(await handleStripeEvent(deps, delivered)).toEqual({ outcome: 'duplicate' });
  });

  it('finds the business only through the stored account, never the event', async () => {
    // One provider for every business, as in production.
    const a = await connected('ready');
    const b = await newBusiness(a.sandbox);
    await startPaymentOnboarding(b.deps, b.owner);
    const bAccount = (await accountOf(b.tenantId))?.providerAccountId ?? '';
    await a.sandbox.setState(bAccount, 'pending');
    a.clock.advanceBy(1000);
    // Delivered through A's deployment, naming B's account: B changes, A doesn't.
    expect(await handleStripeEvent(a.deps, event('account.updated', bAccount))).toEqual({
      outcome: 'processed',
      tenantId: b.tenantId,
    });
    expect((await accountOf(b.tenantId))?.status).toBe('pending');
    expect((await accountOf(a.tenantId))?.status).toBe('onboarding');
    expect(await statusChanges(a.tenantId)).toEqual([]);
    const unknown = await handleStripeEvent(a.deps, event('account.updated', 'acct_unknown000'));
    expect(unknown).toEqual({ outcome: 'ignored', reason: 'unknown_account' });
  });

  it('ignores the other mode, types it doesn’t act on and events without an account', async () => {
    const business = await connected('ready');
    const reads = business.sandbox.reads;
    expect(
      await handleStripeEvent(
        business.deps,
        event('account.updated', business.accountId, { livemode: true }),
      ),
    ).toEqual({ outcome: 'ignored', reason: 'other_mode' });
    expect(
      await handleStripeEvent(business.deps, event('charge.succeeded', business.accountId)),
    ).toEqual({
      outcome: 'ignored',
      reason: 'unhandled_type',
    });
    expect(await handleStripeEvent(business.deps, event('account.updated', null))).toEqual({
      outcome: 'ignored',
      reason: 'no_account',
    });
    expect((await accountOf(business.tenantId))?.status).toBe('onboarding');
    expect(business.sandbox.reads).toBe(reads);
  });

  it('never lets an older read overwrite a newer one (out of order)', async () => {
    const business = await newBusiness();
    await startPaymentOnboarding(business.deps, business.owner);
    const row = await accountOf(business.tenantId);
    if (row === undefined) throw new Error('no account');
    // Two reads: the first starts earlier but answers later, with the older state.
    const answers: { resolve: (account: StripeAccount) => void }[] = [];
    const slow: PaymentsProvider = {
      provider: 'sandbox',
      livemode: false,
      createAccount: (input) => business.sandbox.createAccount(input),
      createOnboardingLink: (input) => business.sandbox.createOnboardingLink(input),
      createDashboardLink: (id) => business.sandbox.createDashboardLink(id),
      retrieveAccount: () =>
        new Promise<StripeAccount>((resolve) => {
          answers.push({ resolve });
        }),
    };
    const deps = { ...business.deps, provider: slow };
    business.clock.advanceBy(1000);
    const older = handleStripeEvent(deps, event('account.updated', row.providerAccountId));
    await expect.poll(() => answers.length, { timeout: 10_000 }).toBe(1);
    business.clock.advanceBy(1000);
    const newer = handleStripeEvent(deps, event('capability.updated', row.providerAccountId));
    await expect.poll(() => answers.length, { timeout: 10_000 }).toBe(2);
    const at = business.clock.now();
    answers[1]?.resolve(
      StripeAccountSchema.parse(sandboxAccount(row.providerAccountId, 'ready', at)),
    );
    await newer;
    answers[0]?.resolve(
      StripeAccountSchema.parse(sandboxAccount(row.providerAccountId, 'pending', at)),
    );
    await older;
    expect((await accountOf(business.tenantId))?.status).toBe('ready');
    expect(await statusChanges(business.tenantId)).toEqual([
      [{ status: 'onboarding' }, { status: 'ready' }, 'system'],
    ]);
  });

  it('pushes once per change, never for a repeat of the same status', async () => {
    const business = await connected('action_needed');
    const ownerId = business.owner.context.userId;
    await withTenant(db, business.tenantId, (tx) =>
      savePushSubscription(tx, {
        userId: ownerId,
        endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString('hex')}`,
        p256dh: 'B'.repeat(87),
        auth: 'a'.repeat(22),
      }),
    );
    await handleStripeEvent(business.deps, event('account.updated', business.accountId));
    business.clock.advanceBy(1000);
    await handleStripeEvent(business.deps, event('account.updated', business.accountId));
    expect(await pushesOf(business.tenantId)).toBe(1);
    await business.sandbox.setState(business.accountId, 'ready');
    business.clock.advanceBy(1000);
    await handleStripeEvent(business.deps, event('capability.updated', business.accountId));
    expect(await pushesOf(business.tenantId)).toBe(2);
  });

  it('reads not_connected once Stripe disconnects; connecting again makes a new account', async () => {
    const business = await connected('ready');
    await handleStripeEvent(business.deps, event('account.updated', business.accountId));
    await business.sandbox.setState(business.accountId, 'deauthorized');
    const gone = event('account.application.deauthorized', business.accountId);
    expect(await handleStripeEvent(business.deps, gone)).toMatchObject({ outcome: 'processed' });
    expect((await readPaymentAccount(business.deps, business.owner)).status).toBe('not_connected');
    expect(await statusChanges(business.tenantId)).toEqual([
      [{ status: 'onboarding' }, { status: 'ready' }, 'system'],
      [{ status: 'ready' }, { status: 'not_connected' }, 'system'],
    ]);
    // A late account.updated for the old account changes nothing.
    expect(
      await handleStripeEvent(business.deps, event('account.updated', business.accountId)),
    ).toMatchObject({
      outcome: 'ignored',
      reason: 'unreadable_account',
    });
    await startPaymentOnboarding(business.deps, business.owner);
    const again = await accountOf(business.tenantId);
    expect(again).toMatchObject({ generation: 2, status: 'onboarding', deauthorizedAt: null });
    expect(again?.providerAccountId).not.toBe(business.accountId);
    // The old account's events now find no business.
    expect(
      await handleStripeEvent(business.deps, event('account.updated', business.accountId)),
    ).toEqual({
      outcome: 'ignored',
      reason: 'unknown_account',
    });
  });
});
