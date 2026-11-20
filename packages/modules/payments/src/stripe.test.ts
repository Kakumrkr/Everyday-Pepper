import { readFileSync } from 'node:fs';
import { snapshotOfStripeAccount, type TenantId } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { PaymentsProviderError } from './provider.js';
import { STRIPE_API_VERSION, StripePaymentsProvider } from './stripe.js';

// Contract tests on Stripe's documented request and answer shapes (ADR-0067 §2).

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

const KEY = 'sk_test_51NvTestKeyForContractTests0000';
const TENANT = '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11' as TenantId;
const ACCOUNT = 'acct_1Nv0FGQ9RKHgCVdK';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  form: Record<string, string>;
}

function stub(status: number, answer: unknown): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? init.body : '';
    seen.push({
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      form: Object.fromEntries(new URLSearchParams(body)),
    });
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { fetch: fake as unknown as typeof fetch, seen };
}

describe('StripePaymentsProvider', () => {
  it('creates an Express account through controller properties, once per key', async () => {
    const { fetch, seen } = stub(200, fixture('account-new'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const account = await stripe.createAccount({
      tenantId: TENANT,
      idempotencyKey: `pepper-account-${TENANT}`,
    });
    expect(account.id).toBe(ACCOUNT);
    const [call] = seen;
    expect(call?.url).toBe('https://api.stripe.com/v1/accounts');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
      'Stripe-Version': STRIPE_API_VERSION,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `pepper-account-${TENANT}`,
    });
    expect(call?.form).toEqual({
      country: 'US',
      'controller[stripe_dashboard][type]': 'express',
      'controller[fees][payer]': 'application',
      'controller[losses][payments]': 'application',
      'controller[requirement_collection]': 'stripe',
      'capabilities[card_payments][requested]': 'true',
      'capabilities[transfers][requested]': 'true',
      'metadata[pepper_tenant]': TENANT,
    });
    // `type` is deprecated in favour of controller (Stripe, 2026).
    expect(call?.form).not.toHaveProperty('type');
    const snapshot = snapshotOfStripeAccount(account);
    expect(snapshot.detailsSubmitted).toBe(false);
    expect(snapshot.pastDue).toContain('external_account');
  });

  it('reads an account with a GET and no idempotency key', async () => {
    const { fetch, seen } = stub(200, fixture('account-due'));
    const account = await new StripePaymentsProvider({ secretKey: KEY, fetch }).retrieveAccount(
      ACCOUNT,
    );
    expect(seen[0]?.url).toBe(`https://api.stripe.com/v1/accounts/${ACCOUNT}`);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers).not.toHaveProperty('Idempotency-Key');
    expect(snapshotOfStripeAccount(account)).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: false,
      currentlyDue: ['individual.verification.document'],
      currentDeadline: '2025-12-03T00:00:00.000Z',
    });
    const ready = await new StripePaymentsProvider({
      secretKey: KEY,
      fetch: stub(200, fixture('account-ready')).fetch,
    }).retrieveAccount(ACCOUNT);
    expect(snapshotOfStripeAccount(ready)).toMatchObject({
      chargesEnabled: true,
      payoutsEnabled: true,
      currentlyDue: [],
    });
  });

  it('asks for an onboarding link that collects everything Stripe will need', async () => {
    const { fetch, seen } = stub(200, fixture('account-link'));
    const link = await new StripePaymentsProvider({ secretKey: KEY, fetch }).createOnboardingLink({
      accountId: ACCOUNT,
      returnUrl: 'https://app.example/more/payments?stripe=return',
      refreshUrl: 'https://app.example/more/payments?stripe=refresh',
    });
    expect(link).toEqual({
      url: 'https://connect.stripe.com/setup/e/acct_1Nv0FGQ9RKHgCVdK/YlI1bFhVZQAbTq',
      expiresAt: new Date(1_763_651_100 * 1000),
    });
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/account_links');
    expect(seen[0]?.form).toEqual({
      account: ACCOUNT,
      type: 'account_onboarding',
      refresh_url: 'https://app.example/more/payments?stripe=refresh',
      return_url: 'https://app.example/more/payments?stripe=return',
      'collection_options[fields]': 'eventually_due',
    });
    expect(seen[0]?.headers['Idempotency-Key']).toMatch(/^pepper-[0-9a-f-]{36}$/);
  });

  it('asks for an Express dashboard link', async () => {
    const { fetch, seen } = stub(200, fixture('login-link'));
    const link = await new StripePaymentsProvider({ secretKey: KEY, fetch }).createDashboardLink(
      ACCOUNT,
    );
    expect(link.url).toBe('https://connect.stripe.com/express/acct_1Nv0FGQ9RKHgCVdK/Kz9cPaVoFHjZ');
    expect(seen[0]?.url).toBe(`https://api.stripe.com/v1/accounts/${ACCOUNT}/login_links`);
    expect(seen[0]?.method).toBe('POST');
  });

  it('knows a live key from a test key', () => {
    expect(new StripePaymentsProvider({ secretKey: KEY }).livemode).toBe(false);
    expect(new StripePaymentsProvider({ secretKey: 'sk_live_51Nv000' }).livemode).toBe(true);
    expect(new StripePaymentsProvider({ secretKey: 'rk_live_51Nv000' }).livemode).toBe(true);
  });

  it('maps Stripe’s errors without its message, retryable or not', async () => {
    const refused = new StripePaymentsProvider({
      secretKey: KEY,
      fetch: stub(404, fixture('error-invalid-request')).fetch,
    });
    const error = await refused.retrieveAccount(ACCOUNT).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PaymentsProviderError);
    expect(error).toMatchObject({
      status: 404,
      type: 'invalid_request_error',
      code: 'resource_missing',
      retryable: false,
    });
    expect((error as Error).message).not.toContain('No such account');

    for (const status of [409, 429, 500, 503]) {
      const failing = new StripePaymentsProvider({
        secretKey: KEY,
        fetch: stub(status, { error: { type: 'api_error' } }).fetch,
      });
      await expect(failing.retrieveAccount(ACCOUNT)).rejects.toMatchObject({
        status,
        retryable: true,
      });
    }
    for (const status of [400, 401, 403]) {
      const failing = new StripePaymentsProvider({
        secretKey: KEY,
        fetch: stub(status, 'not json').fetch,
      });
      await expect(failing.retrieveAccount(ACCOUNT)).rejects.toMatchObject({
        status,
        type: null,
        retryable: false,
      });
    }
  });

  it('treats the network failing and an unreadable answer as retryable', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(
      new StripePaymentsProvider({ secretKey: KEY, fetch: down }).retrieveAccount(ACCOUNT),
    ).rejects.toMatchObject({
      status: null,
      retryable: true,
    });
    const odd = new StripePaymentsProvider({
      secretKey: KEY,
      fetch: stub(200, { id: 'cus_1', object: 'customer' }).fetch,
    });
    await expect(odd.retrieveAccount(ACCOUNT)).rejects.toMatchObject({
      type: 'invalid_answer',
      retryable: true,
    });
  });
});
