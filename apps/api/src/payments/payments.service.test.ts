import 'reflect-metadata';
import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PaymentsProviderError, stripeSignatureHeader } from '@pepper/payments';
import type { Database } from '@pepper/db';
import type { Redis } from '@pepper/runtime';
import { describe, expect, it } from 'vitest';
import { PaymentsService } from './payments.service.js';

// What the api answers before any database work (S65, AC-X-98, AC-X-103): off is 404 on every
// route; a webhook whose signature doesn't check out is 401 before its body is read.

const outboxKey = Buffer.alloc(32, 1);
const db = {} as unknown as Database;
const redis = {} as unknown as Redis;
const tenant = {
  tenantId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11',
  userId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a12',
  role: 'owner',
} as never;
const SECRET = 'whsec_5f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e';

function service(config: ConstructorParameters<typeof PaymentsService>[2]['config']) {
  return new PaymentsService({ db }, redis, {
    config,
    baseUrl: 'http://localhost:3000',
    outboxKey,
  });
}

async function codeOf(work: Promise<unknown>): Promise<unknown> {
  const error = await work.catch((caught: unknown) => caught);
  return (error as { getResponse?: () => unknown }).getResponse?.();
}

describe('PaymentsService', () => {
  it('answers 404 on every route while payments are off', async () => {
    const off = service(null);
    for (const call of [
      off.account(tenant),
      off.onboarding(tenant),
      off.sync(tenant),
      off.dashboard(tenant),
      off.sandboxState(tenant, 'ready'),
    ]) {
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(await codeOf(off.account(tenant))).toMatchObject({ code: 'payments_off' });
    expect(await codeOf(off.receive(Buffer.from('{}'), undefined))).toMatchObject({
      code: 'webhook_not_found',
    });
  });

  it('checks the signature before reading the body (401)', async () => {
    const stripe = service({
      provider: 'stripe',
      secretKey: 'sk_test_51NvServiceUnitTest00000',
      webhookSecret: SECRET,
      publishableKey: 'pk_test_51NvServiceUnitTest00000',
      livemode: false,
    });
    const body = Buffer.from('{"id":"evt_1","object":"event"}');
    for (const signature of [
      undefined,
      'nonsense',
      stripeSignatureHeader('whsec_other_secret_000000000000', body, new Date()),
    ]) {
      await expect(stripe.receive(body, signature)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    await expect(
      stripe.receive(undefined, stripeSignatureHeader(SECRET, body, new Date())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses a signed body that isn’t Stripe’s event (400)', async () => {
    const stripe = service({
      provider: 'stripe',
      secretKey: 'sk_test_51NvServiceUnitTest00000',
      webhookSecret: SECRET,
      publishableKey: 'pk_test_51NvServiceUnitTest00000',
      livemode: false,
    });
    for (const text of ['not json', '{"id":"evt_1","object":"customer"}', 'null']) {
      const body = Buffer.from(text);
      const answer = await codeOf(
        stripe.receive(body, stripeSignatureHeader(SECRET, body, new Date())),
      );
      expect(answer).toMatchObject({ code: 'validation_failed' });
    }
  });

  it('signs the sandbox’s events with its own secret only', async () => {
    const sandbox = service({ provider: 'sandbox' });
    const body = Buffer.from('{}');
    // Not Stripe's secret, nor any a caller could know.
    await expect(
      sandbox.receive(body, stripeSignatureHeader(SECRET, body, new Date())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses the sandbox’s dev path with Stripe (404)', async () => {
    const stripe = service({
      provider: 'stripe',
      secretKey: 'sk_test_51NvServiceUnitTest00000',
      webhookSecret: SECRET,
      publishableKey: 'pk_test_51NvServiceUnitTest00000',
      livemode: false,
    });
    await expect(stripe.sandboxState(tenant, 'ready')).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---- Deposits (S66) ----
  const STRIPE = {
    provider: 'stripe',
    secretKey: 'sk_test_51NvServiceUnitTest00000',
    webhookSecret: SECRET,
    publishableKey: 'pk_test_51NvServiceUnitTest00000',
    livemode: false,
  } as const;
  const paying = {
    tenantId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11',
    requestId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a13',
    startsAt: new Date('2099-03-10T17:00:00Z'),
    terms: { kind: 'deposit', amountCents: 1500, refundHours: 24 },
    description: 'Juniper: Fade',
  } as never;

  it('gives no deposit hooks while payments are off, and 404 for a payment', async () => {
    const off = service(null);
    expect(off.publicDeposits()).toBeUndefined();
    expect(off.teamCancelled()).toBeUndefined();
    expect(off.teamMoved()).toBeUndefined();
    expect(() => off.startPayment(paying)).toThrow(NotFoundException);
    await expect(off.sandboxIntent('pi_x_secret_y', 'succeeded')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('gives every deposit hook when payments are on', () => {
    const stripe = service(STRIPE);
    const hooks = stripe.publicDeposits();
    expect(Object.keys(hooks ?? {}).sort()).toEqual([
      'attach',
      'cancelled',
      'describe',
      'open',
      'ready',
      'rescheduled',
    ]);
    expect(typeof stripe.teamCancelled()).toBe('function');
    expect(typeof stripe.teamMoved()).toBe('function');
  });

  it('answers the sandbox card only in the sandbox: 404 with Stripe', async () => {
    await expect(
      service(STRIPE).sandboxIntent('pi_x_secret_y', 'succeeded'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps the sandbox’s refusals: unknown 404, already settled 409, others thrown', async () => {
    const sandbox = service({ provider: 'sandbox' });
    // The bound sandbox is private: its card is replaced to answer each refusal.
    const inner = (sandbox as unknown as { bound: { sandbox: { settleIntent: unknown } } }).bound
      .sandbox;
    const refuse = (error: Error) => {
      inner.settleIntent = () => Promise.reject(error);
    };
    refuse(new PaymentsProviderError(404, 'invalid_request_error', 'resource_missing', false));
    await expect(sandbox.sandboxIntent('pi_x_secret_y', 'succeeded')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    refuse(new PaymentsProviderError(400, 'invalid_request_error', null, false));
    await expect(sandbox.sandboxIntent('pi_x_secret_y', 'declined')).rejects.toBeInstanceOf(
      ConflictException,
    );
    refuse(new Error('redis down'));
    await expect(sandbox.sandboxIntent('pi_x_secret_y', 'declined')).rejects.toThrow('redis down');
    inner.settleIntent = () => Promise.resolve();
    await expect(sandbox.sandboxIntent('pi_x_secret_y', 'succeeded')).resolves.toBeUndefined();
  });
});
