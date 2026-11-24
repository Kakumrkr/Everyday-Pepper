import 'reflect-metadata';
import type { IncomingMessage } from 'node:http';
import { PaymentAccountAnswerSchema, type PaymentAccountAnswer } from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import { describe, expect, it, vi } from 'vitest';
import type { RateLimiter } from '../http/rate-limit.js';
import {
  PaymentsController,
  PaymentsModule,
  PaymentsSandboxController,
  PaymentsWebhookController,
} from './payments.controller.js';
import type { PaymentsService } from './payments.service.js';

// The controllers without Nest or a database (S65): each owner action counts against the
// business's limit before Stripe is asked, answers are parsed on the way out, the webhook reads
// Stripe's header and the raw bytes, and the sandbox's route is mounted only with the sandbox.
// payments.int.test.ts proves the whole path.

const tenant = {
  tenantId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a11',
  userId: '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a12',
  role: 'owner',
} as unknown as TenantContext;
const ANSWER: PaymentAccountAnswer = PaymentAccountAnswerSchema.parse({
  status: 'ready',
  chargesEnabled: true,
  payoutsEnabled: true,
  detailsSubmitted: true,
  due: [],
  eventuallyDue: [],
  dueBy: null,
  disabledReason: null,
  syncedAt: '2026-11-20T15:00:00.000Z',
  canManage: true,
});

function fakes() {
  const payments = {
    account: vi.fn(() => Promise.resolve(ANSWER)),
    onboarding: vi.fn(() =>
      Promise.resolve({
        url: 'https://connect.stripe.com/x',
        expiresAt: '2026-11-20T15:05:00.000Z',
      }),
    ),
    sync: vi.fn(() => Promise.resolve(ANSWER)),
    dashboard: vi.fn(() => Promise.resolve({ url: 'https://connect.stripe.com/express/x' })),
    receive: vi.fn(() => Promise.resolve({ received: true as const })),
    sandboxState: vi.fn(() => Promise.resolve(ANSWER)),
    bookingDeposit: vi.fn(() =>
      Promise.resolve({
        kind: 'deposit' as const,
        amountCents: 1500,
        refundEndsAt: '2026-11-24T20:00:00.000Z',
        status: 'held' as const,
        refundableNow: true,
      }),
    ),
  };
  const limits = { hit: vi.fn(() => Promise.resolve()) };
  return {
    payments,
    limits,
    service: payments as unknown as PaymentsService,
    limiter: limits as unknown as RateLimiter,
  };
}

describe('PaymentsController', () => {
  it('counts each owner action against the business before asking Stripe', async () => {
    const { payments, limits, service, limiter } = fakes();
    const controller = new PaymentsController(service, limiter);
    expect(await controller.account(tenant)).toEqual(ANSWER);
    expect(limits.hit).not.toHaveBeenCalled();
    expect((await controller.onboarding(tenant)).url).toBe('https://connect.stripe.com/x');
    expect(await controller.sync(tenant)).toEqual(ANSWER);
    expect((await controller.dashboard(tenant)).url).toBe('https://connect.stripe.com/express/x');
    expect(limits.hit).toHaveBeenCalledTimes(3);
    expect(limits.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payments-owner' }),
      tenant.tenantId,
    );
    expect(payments.onboarding).toHaveBeenCalledWith(tenant);
  });

  it('answers nothing Stripe sent that isn’t in the contract', async () => {
    const { payments, service, limiter } = fakes();
    payments.account.mockResolvedValueOnce({ ...ANSWER, secret: 'x' } as never);
    await expect(new PaymentsController(service, limiter).account(tenant)).rejects.toThrow();
  });
});

describe("the team's view of a booking's deposit (S67, AC-X-129)", () => {
  const BOOKING = '0b9b2f9e-8d6d-4e7c-9d7f-3c1f0c9a1a13';

  it('answers the deposit, or null, without counting against the owner limit', async () => {
    const { payments, limits, service, limiter } = fakes();
    const controller = new PaymentsController(service, limiter);
    const answer = await controller.bookingDeposit(tenant, { bookingId: BOOKING });
    expect(answer.deposit).toMatchObject({ amountCents: 1500, status: 'held' });
    expect(payments.bookingDeposit).toHaveBeenCalledWith(tenant, BOOKING);
    payments.bookingDeposit.mockResolvedValueOnce(null as never);
    expect(await controller.bookingDeposit(tenant, { bookingId: BOOKING })).toEqual({
      deposit: null,
    });
    expect(limits.hit).not.toHaveBeenCalled();
  });

  it('refuses an id that is not one, before asking anything', async () => {
    const { payments, service, limiter } = fakes();
    const controller = new PaymentsController(service, limiter);
    await expect(controller.bookingDeposit(tenant, { bookingId: 'x' })).rejects.toThrow();
    expect(payments.bookingDeposit).not.toHaveBeenCalled();
  });
});

describe('PaymentsWebhookController', () => {
  it('passes the raw bytes and Stripe’s header (first of repeats) to the check', async () => {
    const { payments, limits, service, limiter } = fakes();
    const controller = new PaymentsWebhookController(service, limiter);
    const raw = Buffer.from('{}');
    const request = {
      rawBody: raw,
      headers: { 'stripe-signature': ['t=1,v1=a', 't=2,v1=b'] },
      socket: { remoteAddress: '203.0.113.9' },
    } as unknown as IncomingMessage & { rawBody?: Buffer };
    expect(await controller.receive(request)).toEqual({ received: true });
    expect(payments.receive).toHaveBeenCalledWith(raw, 't=1,v1=a');
    expect(limits.hit).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'payments-webhook-ip' }),
      expect.any(String),
    );
    const single = {
      rawBody: raw,
      headers: { 'stripe-signature': 't=3,v1=c' },
      socket: { remoteAddress: '203.0.113.9' },
    } as unknown as typeof request;
    await controller.receive(single);
    expect(payments.receive).toHaveBeenLastCalledWith(raw, 't=3,v1=c');
  });
});

describe('PaymentsSandboxController', () => {
  it('validates the state before the sandbox moves anything', async () => {
    const { payments, service } = fakes();
    const controller = new PaymentsSandboxController(service);
    expect(await controller.account(tenant, { state: 'ready' })).toEqual(ANSWER);
    expect(payments.sandboxState).toHaveBeenCalledWith(tenant, 'ready');
    await expect(controller.account(tenant, { state: 'sideways' })).rejects.toMatchObject({
      status: 400,
    });
    expect(payments.sandboxState).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentsModule', () => {
  const options = { baseUrl: 'http://localhost:3000', outboxKey: Buffer.alloc(32) };

  it('mounts the sandbox’s route only with the sandbox', () => {
    expect(
      PaymentsModule.forRoot({ ...options, config: { provider: 'sandbox' } }).controllers,
    ).toContain(PaymentsSandboxController);
    for (const config of [
      null,
      {
        provider: 'stripe' as const,
        secretKey: 'sk_test_x',
        webhookSecret: 'whsec_x',
        publishableKey: 'pk_test_51NvControllerTest0000',
        livemode: false,
      },
    ]) {
      const mounted = PaymentsModule.forRoot({ ...options, config }).controllers ?? [];
      expect(mounted).not.toContain(PaymentsSandboxController);
      expect(mounted).toContain(PaymentsWebhookController);
    }
  });
});
