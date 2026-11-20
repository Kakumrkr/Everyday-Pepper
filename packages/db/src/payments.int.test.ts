// Payments' records (S65, ADR-0067, AC-X-96…99): a business's one Stripe account (its own row
// only; a newer read wins; disconnected, then replaced once), the definer that maps a Stripe
// account to its business (ids only), and webhook events written in the webhook's context, each
// claimed once. Part of the isolation evidence with isolation.int.test.ts.
import {
  TenantIdSchema,
  type PaymentAccountSnapshot,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { scheduleCurrentTenantDeletion } from './repositories/deletion.js';
import { readBusinessExport } from './repositories/business-export.js';
import {
  applyPaymentAccountSync,
  claimPaymentWebhookEvent,
  deleteOldPaymentWebhookEvents,
  findPaymentAccount,
  findPaymentWebhookEvent,
  finishPaymentWebhookEvent,
  insertPaymentAccount,
  markPaymentAccountDeauthorized,
  paymentAccountSnapshotOf,
  paymentAccountTenant,
  replacePaymentAccount,
  type NewPaymentAccount,
} from './repositories/payments.js';
import { createTenant } from './repositories/tenants.js';
import { setTransactionPaymentsWebhook, withPaymentsWebhook, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let owner: UserId;
const T0 = new Date('2026-11-20T15:00:00Z');

const ONBOARDING: PaymentAccountSnapshot = {
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  currentlyDue: ['external_account', 'tos_acceptance.date'],
  pastDue: [],
  eventuallyDue: ['external_account', 'tos_acceptance.date'],
  pendingVerification: [],
  currentDeadline: null,
  disabledReason: 'requirements.past_due',
};
const READY: PaymentAccountSnapshot = {
  ...ONBOARDING,
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  currentlyDue: [],
  eventuallyDue: [],
  disabledReason: null,
};

function accountId(): string {
  return `acct_${randomBytes(8).toString('hex')}`;
}

function newAccount(overrides: Partial<NewPaymentAccount> = {}): NewPaymentAccount {
  return {
    provider: 'stripe',
    providerAccountId: accountId(),
    generation: 1,
    livemode: false,
    status: 'onboarding',
    snapshot: ONBOARDING,
    syncedAt: T0,
    createdBy: owner,
    ...overrides,
  };
}

async function business(slug: string): Promise<TenantId> {
  return TenantIdSchema.parse(
    (await createTenant(db, { name: slug, slug, timeZone: 'America/New_York' })).id,
  );
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db);
});

afterAll(async () => {
  await database.stop();
});

describe('payment_accounts', () => {
  it('holds one account per business; a second insert keeps the first', async () => {
    const tenant = await business('pay-one');
    const first = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    const second = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    const stored = await withTenant(db, tenant, (tx) => findPaymentAccount(tx));
    expect(stored?.providerAccountId).toBe(first?.providerAccountId);
    expect(stored && paymentAccountSnapshotOf(stored)).toEqual(ONBOARDING);
  });

  it('refuses the same Stripe account for two businesses', async () => {
    const a = await business('pay-dup-a');
    const b = await business('pay-dup-b');
    const shared = accountId();
    await withTenant(db, a, (tx) =>
      insertPaymentAccount(tx, newAccount({ providerAccountId: shared })),
    );
    // On conflict do nothing covers it too: business B gets no row, never A's.
    expect(
      await withTenant(db, b, (tx) =>
        insertPaymentAccount(tx, newAccount({ providerAccountId: shared })),
      ),
    ).toBeUndefined();
    expect(await withTenant(db, b, (tx) => findPaymentAccount(tx))).toBeUndefined();
  });

  it('applies a newer read only, so reads finishing out of order never move it back', async () => {
    const tenant = await business('pay-order');
    const row = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    if (row === undefined) throw new Error('not stored');
    const later = new Date(T0.getTime() + 60_000);
    const ready = await withTenant(db, tenant, (tx) =>
      applyPaymentAccountSync(tx, {
        id: row.id,
        providerAccountId: row.providerAccountId,
        snapshot: READY,
        status: 'ready',
        syncedAt: later,
      }),
    );
    expect(ready?.status).toBe('ready');
    // A read made before it finishes last: not applied.
    const stale = await withTenant(db, tenant, (tx) =>
      applyPaymentAccountSync(tx, {
        id: row.id,
        providerAccountId: row.providerAccountId,
        snapshot: ONBOARDING,
        status: 'onboarding',
        syncedAt: new Date(T0.getTime() + 30_000),
      }),
    );
    expect(stale).toBeUndefined();
    // The same moment again: not applied either (a strictly newer read only).
    expect(
      await withTenant(db, tenant, (tx) =>
        applyPaymentAccountSync(tx, {
          id: row.id,
          providerAccountId: row.providerAccountId,
          snapshot: ONBOARDING,
          status: 'onboarding',
          syncedAt: later,
        }),
      ),
    ).toBeUndefined();
    expect((await withTenant(db, tenant, (tx) => findPaymentAccount(tx)))?.status).toBe('ready');
  });

  it('never applies a read of another account, or of another business', async () => {
    const a = await business('pay-cross-a');
    const b = await business('pay-cross-b');
    const rowA = await withTenant(db, a, (tx) => insertPaymentAccount(tx, newAccount()));
    if (rowA === undefined) throw new Error('not stored');
    const later = new Date(T0.getTime() + 60_000);
    const sync = { snapshot: READY, status: 'ready' as const, syncedAt: later };
    expect(
      await withTenant(db, a, (tx) =>
        applyPaymentAccountSync(tx, { id: rowA.id, providerAccountId: accountId(), ...sync }),
      ),
    ).toBeUndefined();
    expect(
      await withTenant(db, b, (tx) =>
        applyPaymentAccountSync(tx, {
          id: rowA.id,
          providerAccountId: rowA.providerAccountId,
          ...sync,
        }),
      ),
    ).toBeUndefined();
    expect((await withTenant(db, a, (tx) => findPaymentAccount(tx)))?.status).toBe('onboarding');
  });

  it('is disconnected once, then replaced once by a new account of the next generation', async () => {
    const tenant = await business('pay-reconnect');
    const row = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    if (row === undefined) throw new Error('not stored');
    const off = { id: row.id, providerAccountId: row.providerAccountId, at: T0 };
    expect(
      (await withTenant(db, tenant, (tx) => markPaymentAccountDeauthorized(tx, off)))?.status,
    ).toBe('not_connected');
    expect(
      await withTenant(db, tenant, (tx) => markPaymentAccountDeauthorized(tx, off)),
    ).toBeUndefined();
    // A disconnected account takes no more reads.
    expect(
      await withTenant(db, tenant, (tx) =>
        applyPaymentAccountSync(tx, {
          id: row.id,
          providerAccountId: row.providerAccountId,
          snapshot: READY,
          status: 'ready',
          syncedAt: new Date(T0.getTime() + 60_000),
        }),
      ),
    ).toBeUndefined();
    const next = newAccount({ generation: 2 });
    const replaced = await withTenant(db, tenant, (tx) =>
      replacePaymentAccount(tx, row.id, 1, next),
    );
    expect(replaced).toMatchObject({
      providerAccountId: next.providerAccountId,
      generation: 2,
      deauthorizedAt: null,
      status: 'onboarding',
    });
    // A second reconnect racing the first finds it connected: nothing changes.
    expect(
      await withTenant(db, tenant, (tx) =>
        replacePaymentAccount(tx, row.id, 1, newAccount({ generation: 2 })),
      ),
    ).toBeUndefined();
  });

  it('can’t be deleted by the services; goes with the business', async () => {
    const tenant = await business('pay-keep');
    await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    const refused = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`DELETE FROM payment_accounts`),
    ).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('42501');
  });

  it('refuses a live sandbox account and Stripe-shaped junk', async () => {
    const tenant = await business('pay-checks');
    for (const bad of [
      newAccount({ provider: 'sandbox', livemode: true }),
      newAccount({ status: 'connected' as never }),
      newAccount({ snapshot: { ...ONBOARDING, disabledReason: 'Not A Reason' } }),
    ]) {
      await expect(withTenant(db, tenant, (tx) => insertPaymentAccount(tx, bad))).rejects.toThrow();
    }
  });

  it('is in the business’s export', async () => {
    const tenant = await business('pay-export');
    const row = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    const data = await withTenant(db, tenant, (tx) => readBusinessExport(tx));
    expect(data.payments).toEqual({
      provider: 'stripe',
      accountId: row?.providerAccountId,
      status: 'onboarding',
      chargesEnabled: false,
      payoutsEnabled: false,
      connectedAt: row?.createdAt,
      disconnectedAt: null,
    });
    const none = await business('pay-export-none');
    expect((await withTenant(db, none, (tx) => readBusinessExport(tx))).payments).toBeNull();
  });
});

describe('payment_account_tenant', () => {
  it('answers the business of a stored account and nothing else', async () => {
    const tenant = await business('pay-lookup');
    const row = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    if (row === undefined) throw new Error('not stored');
    expect(await paymentAccountTenant(db, 'stripe', row.providerAccountId)).toBe(tenant);
    expect(await paymentAccountTenant(db, 'sandbox', row.providerAccountId)).toBeNull();
    expect(await paymentAccountTenant(db, 'stripe', accountId())).toBeNull();
    // Without the definer, nothing of the row is reachable outside its business.
    const outside = await db.execute(sql`SELECT count(*)::int AS n FROM payment_accounts`);
    expect(outside.rows[0]).toEqual({ n: 0 });
  });

  it('leaves out a business being deleted', async () => {
    const tenant = await business('pay-leaving');
    const row = await withTenant(db, tenant, (tx) => insertPaymentAccount(tx, newAccount()));
    if (row === undefined) throw new Error('not stored');
    await withTenant(db, tenant, (tx) =>
      scheduleCurrentTenantDeletion(tx, new Date(Date.now() + 30 * 86_400_000)),
    );
    expect(await paymentAccountTenant(db, 'stripe', row.providerAccountId)).toBeNull();
  });
});

describe('payment_webhook_events', () => {
  function event(eventId = `evt_${randomBytes(10).toString('hex')}`) {
    return {
      provider: 'stripe' as const,
      eventId,
      eventType: 'account.updated',
      accountId: accountId(),
      livemode: false,
      createdAtProvider: T0,
      receivedAt: T0,
    };
  }

  it('claims an event once: a redelivery of a handled one answers its outcome', async () => {
    const input = event();
    const first = await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, input));
    expect(first).toMatchObject({ outcome: 'received', attempts: 1 });
    // The earlier attempt failed (nothing finished it): handle it again, counted.
    const retry = await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, input));
    expect(retry).toEqual({ id: first.id, outcome: 'received', attempts: 2 });
    const tenant = await business('pay-events');
    await withTenant(db, tenant, async (tx) => {
      await setTransactionPaymentsWebhook(tx);
      await finishPaymentWebhookEvent(tx, first.id, {
        outcome: 'processed',
        tenantId: tenant,
        at: T0,
      });
    });
    const replay = await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, input));
    expect(replay).toEqual({ id: first.id, outcome: 'processed', attempts: 2 });
    const stored = await withPaymentsWebhook(db, (tx) =>
      findPaymentWebhookEvent(tx, 'stripe', input.eventId),
    );
    expect(stored).toMatchObject({ outcome: 'processed', tenantId: tenant, processedAt: T0 });
  });

  it('keeps an ignored event’s reason, and finishing twice changes nothing', async () => {
    const input = event();
    const { id } = await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, input));
    await withPaymentsWebhook(db, (tx) =>
      finishPaymentWebhookEvent(tx, id, {
        outcome: 'ignored',
        reason: 'unknown_account',
        tenantId: null,
        at: T0,
      }),
    );
    await withPaymentsWebhook(db, (tx) =>
      finishPaymentWebhookEvent(tx, id, {
        outcome: 'ignored',
        reason: 'other_mode',
        tenantId: null,
        at: T0,
      }),
    );
    const stored = await withPaymentsWebhook(db, (tx) =>
      findPaymentWebhookEvent(tx, 'stripe', input.eventId),
    );
    expect(stored).toMatchObject({ outcome: 'ignored', ignoredReason: 'unknown_account' });
  });

  it('is reachable only in the webhook context', async () => {
    const tenant = await business('pay-events-tenant');
    await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, event()));
    const inTenant = await withTenant(db, tenant, (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM payment_webhook_events`),
    );
    expect(inTenant.rows[0]).toEqual({ n: 0 });
    const refused = await withTenant(db, tenant, (tx) =>
      claimPaymentWebhookEvent(tx, event()),
    ).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('42501');
  });

  it('is deleted 30 days on by the clean-up, oldest first, in batches', async () => {
    const old = { ...event(), receivedAt: new Date('2026-01-01T00:00:00Z') };
    const recent = event();
    await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, old));
    await withPaymentsWebhook(db, (tx) => claimPaymentWebhookEvent(tx, recent));
    const before = new Date('2026-02-01T00:00:00Z');
    let deleted = 0;
    for (;;) {
      const batch = await withPaymentsWebhook(db, (tx) =>
        deleteOldPaymentWebhookEvents(tx, before, 1),
      );
      deleted += batch;
      if (batch === 0) break;
    }
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      await withPaymentsWebhook(db, (tx) => findPaymentWebhookEvent(tx, 'stripe', old.eventId)),
    ).toBeUndefined();
    expect(
      await withPaymentsWebhook(db, (tx) => findPaymentWebhookEvent(tx, 'stripe', recent.eventId)),
    ).toBeDefined();
  });
});
