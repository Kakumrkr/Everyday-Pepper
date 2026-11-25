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

describe('StripePaymentsProvider: deposits and cards (S66, ADR-0068 §3)', () => {
  const CUSTOMER = 'cus_P4nTGqV1aBcD2e';
  const INTENT = 'pi_3Nv0HdQ9RKHgCVdK1aBcDeFg';
  const REQUEST = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708100';

  it('makes a customer without the client’s name or email, once per key', async () => {
    const { fetch, seen } = stub(200, fixture('customer'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const customer = await stripe.createCustomer({
      tenantId: TENANT,
      idempotencyKey: 'pepper-customer-r1',
    });
    expect(customer).toEqual({ id: CUSTOMER });
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/customers');
    expect(seen[0]?.headers['Idempotency-Key']).toBe('pepper-customer-r1');
    expect(seen[0]?.form).toEqual({ 'metadata[pepper_tenant]': TENANT });
  });

  it('authorizes a destination charge on the business’s behalf and keeps the card', async () => {
    const { fetch, seen } = stub(200, fixture('payment-intent-authorized'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const intent = await stripe.createDeposit({
      tenantId: TENANT,
      requestId: REQUEST,
      accountId: ACCOUNT,
      customerId: CUSTOMER,
      amountCents: 1500,
      description: 'Juniper: Fade',
      idempotencyKey: 'pepper-deposit-r1',
    });
    expect(intent).toMatchObject({ id: INTENT, status: 'requires_capture', amount: 1500 });
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(seen[0]?.form).toEqual({
      amount: '1500',
      currency: 'usd',
      customer: CUSTOMER,
      capture_method: 'manual',
      setup_future_usage: 'off_session',
      on_behalf_of: ACCOUNT,
      'transfer_data[destination]': ACCOUNT,
      'automatic_payment_methods[enabled]': 'true',
      'automatic_payment_methods[allow_redirects]': 'never',
      description: 'Juniper: Fade',
      'metadata[pepper_tenant]': TENANT,
      'metadata[pepper_request]': REQUEST,
    });
  });

  it('keeps a card with nothing paid through a setup on the business’s behalf', async () => {
    const { fetch, seen } = stub(200, fixture('setup-intent'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const setup = await stripe.createCardSetup({
      tenantId: TENANT,
      requestId: REQUEST,
      accountId: ACCOUNT,
      customerId: CUSTOMER,
      idempotencyKey: 'pepper-card-r1',
    });
    expect(setup.status).toBe('requires_payment_method');
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/setup_intents');
    expect(seen[0]?.form).toMatchObject({
      customer: CUSTOMER,
      usage: 'off_session',
      on_behalf_of: ACCOUNT,
    });
  });

  it('reads, captures and lets go of a payment, each POST with its key', async () => {
    const { fetch, seen } = stub(200, fixture('payment-intent-authorized'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    await stripe.retrievePaymentIntent(INTENT);
    await stripe.capturePaymentIntent(INTENT, 'pepper-capture-p1');
    await stripe.cancelPaymentIntent(INTENT, 'pepper-void-p1');
    expect(seen.map((call) => [call.method, call.url])).toEqual([
      ['GET', `https://api.stripe.com/v1/payment_intents/${INTENT}`],
      ['POST', `https://api.stripe.com/v1/payment_intents/${INTENT}/capture`],
      ['POST', `https://api.stripe.com/v1/payment_intents/${INTENT}/cancel`],
    ]);
    expect(seen[1]?.headers['Idempotency-Key']).toBe('pepper-capture-p1');
    expect(seen[2]?.form).toEqual({ cancellation_reason: 'abandoned' });
  });

  it('refunds the whole payment, reversing the transfer to the business', async () => {
    const { fetch, seen } = stub(200, fixture('refund'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const refund = await stripe.createRefund(INTENT, 'pepper-refund-p1');
    expect(refund).toMatchObject({ status: 'succeeded', amount: 1500 });
    expect(seen[0]?.form).toEqual({
      payment_intent: INTENT,
      reverse_transfer: 'true',
      reason: 'requested_by_customer',
    });
    expect(seen[0]?.headers['Idempotency-Key']).toBe('pepper-refund-p1');
    await stripe.retrieveRefund(refund.id);
    expect(seen[1]?.url).toBe(`https://api.stripe.com/v1/refunds/${refund.id}`);
  });

  it('charges a kept card off-session on the business’s behalf, once per key (S68, AC-X-140)', async () => {
    const { fetch, seen } = stub(200, fixture('payment-intent-fee'));
    const stripe = new StripePaymentsProvider({ secretKey: KEY, fetch });
    const charged = await stripe.createOffSessionCharge({
      tenantId: TENANT,
      bookingFeeId: 'f1',
      accountId: ACCOUNT,
      customerId: CUSTOMER,
      paymentMethodId: 'pm_1Nv0HdQ9RKHgCVdKcard',
      amountCents: 2000,
      description: 'Sunny Cuts · missed visit',
      idempotencyKey: 'pepper-fee-f1',
    });
    expect(charged).toMatchObject({
      status: 'succeeded',
      payment_method: 'pm_1Nv0HdQ9RKHgCVdKcard',
    });
    expect(seen[0]?.url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(seen[0]?.form).toEqual({
      amount: '2000',
      currency: 'usd',
      customer: CUSTOMER,
      payment_method: 'pm_1Nv0HdQ9RKHgCVdKcard',
      off_session: 'true',
      confirm: 'true',
      on_behalf_of: ACCOUNT,
      'transfer_data[destination]': ACCOUNT,
      description: 'Sunny Cuts · missed visit',
      'metadata[pepper_tenant]': TENANT,
      'metadata[pepper_fee]': 'f1',
    });
    expect(seen[0]?.headers['Idempotency-Key']).toBe('pepper-fee-f1');
  });

  it('says a declined off-session charge by Stripe’s code, not worth retrying', async () => {
    const stripe = new StripePaymentsProvider({
      secretKey: KEY,
      fetch: stub(402, fixture('error-card-declined')).fetch,
    });
    await expect(
      stripe.createOffSessionCharge({
        tenantId: TENANT,
        bookingFeeId: 'f1',
        accountId: ACCOUNT,
        customerId: CUSTOMER,
        paymentMethodId: 'pm_1',
        amountCents: 2000,
        description: 'd',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({
      status: 402,
      type: 'card_error',
      code: 'card_declined',
      retryable: false,
    });
  });

  it('refuses an answer that isn’t the object asked for', async () => {
    const stripe = new StripePaymentsProvider({
      secretKey: KEY,
      fetch: stub(200, fixture('refund')).fetch,
    });
    await expect(stripe.retrievePaymentIntent(INTENT)).rejects.toMatchObject({
      type: 'invalid_answer',
    });
  });
});
