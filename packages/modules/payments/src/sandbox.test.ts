import {
  paymentAccountStatus,
  SandboxPaymentStateSchema,
  snapshotOfStripeAccount,
  type TenantId,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemorySandboxAccountStore,
  RedisSandboxAccountStore,
  SandboxPaymentsProvider,
} from './sandbox.js';

const TENANT = '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11' as TenantId;
const NOW = new Date('2026-11-20T15:00:00Z');

function sandbox() {
  return new SandboxPaymentsProvider({
    store: new MemorySandboxAccountStore(),
    baseUrl: 'http://localhost:3000',
    now: () => NOW,
  });
}

describe('SandboxPaymentsProvider (AC-X-101)', () => {
  it('answers the same account for the same key, as Stripe does', async () => {
    const provider = sandbox();
    const first = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k1' });
    const again = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k1' });
    const other = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k2' });
    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(first.id).toMatch(/^acct_sandbox[0-9a-f]{16}$/);
    expect(provider.livemode).toBe(false);
  });

  it('starts in onboarding, and its link goes straight back to Pepper', async () => {
    const provider = sandbox();
    const account = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k' });
    expect(paymentAccountStatus({ ...snapshotOfStripeAccount(account), deauthorized: false })).toBe(
      'onboarding',
    );
    const link = await provider.createOnboardingLink({
      accountId: account.id,
      returnUrl: 'http://localhost:3000/more/payments?stripe=return',
      refreshUrl: 'http://localhost:3000/more/payments?stripe=refresh',
    });
    expect(link).toEqual({
      url: 'http://localhost:3000/more/payments?stripe=return',
      expiresAt: new Date(NOW.getTime() + 300_000),
    });
    expect((await provider.createDashboardLink(account.id)).url).toBe(
      'http://localhost:3000/more/payments?sandbox=dashboard',
    );
  });

  it('moves an account to each state a journey needs', async () => {
    const provider = sandbox();
    const { id } = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k' });
    for (const state of SandboxPaymentStateSchema.options) {
      if (state === 'deauthorized') continue;
      await provider.setState(id, state);
      const snapshot = snapshotOfStripeAccount(await provider.retrieveAccount(id));
      expect(paymentAccountStatus({ ...snapshot, deauthorized: false }), state).toBe(state);
    }
    await provider.setState(id, 'action_needed');
    const due = snapshotOfStripeAccount(await provider.retrieveAccount(id));
    expect(due.currentDeadline).toBe('2026-12-04T15:00:00.000Z');
  });

  it('refuses an unknown or disconnected account as Stripe would', async () => {
    const provider = sandbox();
    await expect(provider.retrieveAccount('acct_unknown')).rejects.toMatchObject({
      status: 403,
      retryable: false,
    });
    const { id } = await provider.createAccount({ tenantId: TENANT, idempotencyKey: 'k' });
    await provider.setState(id, 'deauthorized');
    await expect(provider.retrieveAccount(id)).rejects.toMatchObject({ code: 'account_invalid' });
  });

  it('keeps accounts in Redis for a day, under its own prefix', async () => {
    const calls: unknown[][] = [];
    const values = new Map<string, string>();
    const store = new RedisSandboxAccountStore({
      get: (key) => Promise.resolve(values.get(key) ?? null),
      set: (key, value, mode, seconds) => {
        calls.push([key, mode, seconds]);
        values.set(key, value);
        return Promise.resolve('OK');
      },
    });
    await store.set('account:acct_1', '{}');
    expect(await store.get('account:acct_1')).toBe('{}');
    expect(calls).toEqual([['pepper:payments-sandbox:account:acct_1', 'EX', 86_400]]);
  });
});
