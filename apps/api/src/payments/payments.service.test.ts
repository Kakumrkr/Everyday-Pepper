import 'reflect-metadata';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { stripeSignatureHeader } from '@pepper/payments';
import type { Database } from '@pepper/db';
import type { Redis } from '@pepper/runtime';
import { describe, expect, it } from 'vitest';
import { PaymentsService } from './payments.service.js';

// What the api answers before any database work (S65, AC-X-95, AC-X-100): off is 404 on every
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

  it('refuses the sandbox’s dev path with Stripe (404)', async () => {
    const stripe = service({
      provider: 'stripe',
      secretKey: 'sk_test_51NvServiceUnitTest00000',
      webhookSecret: SECRET,
      livemode: false,
    });
    await expect(stripe.sandboxState(tenant, 'ready')).rejects.toBeInstanceOf(NotFoundException);
  });
});
