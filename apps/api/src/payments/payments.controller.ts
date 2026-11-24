import type { IncomingMessage } from 'node:http';
import {
  BookingDepositAnswerSchema,
  BookingIdSchema,
  PaymentAccountAnswerSchema,
  PaymentDashboardLinkSchema,
  PaymentOnboardingLinkSchema,
  SandboxIntentRequestSchema,
  SandboxPaymentRequestSchema,
  type BookingDepositAnswer,
  type PaymentAccountAnswer,
  type PaymentDashboardLink,
  type PaymentOnboardingLink,
  type WebhookAck,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { CurrentTenant, RequirePermission, SkipOriginCheck, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';
import { z } from 'zod';
import { PAYMENTS_OPTIONS, PaymentsService, type PaymentsOptions } from './payments.service.js';

// Payments (S65, ADR-0067, AC-X-96…104). The owner connects the business's Stripe account
// (`payments.manage`); owners and managers read where it stands (`payments.read`); staff get
// 403. Stripe's webhook has no session and no Origin: its signature is the check. Off: 404.

/** Each owner action asks Stripe once; a business needs a handful a day at most. */
const OWNER_CALLS: RateLimit = { name: 'payments-owner', max: 30, windowSeconds: 600 };
// Stripe calls from many addresses; the limit only stops a flood (each refused call costs one HMAC).
const DELIVERIES: RateLimit = { name: 'payments-webhook-ip', max: 1200, windowSeconds: 600 };
// The sandbox's card (S66): journeys pay a handful of times; nothing more is needed.
const BookingParamsSchema = z.object({ bookingId: BookingIdSchema });
const SANDBOX_CARDS: RateLimit = { name: 'payments-sandbox-card-ip', max: 120, windowSeconds: 600 };

@Controller('v1/payments')
@UseGuards(TenantGuard)
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly limits: RateLimiter,
  ) {}

  /** 200 where payments stand (AC-X-97); 403 staff; 404 `payments_off`. */
  @Get('account')
  @RequirePermission('payments.read')
  async account(@CurrentTenant() tenant: TenantContext): Promise<PaymentAccountAnswer> {
    return PaymentAccountAnswerSchema.parse(await answering(() => this.payments.account(tenant)));
  }

  /**
   * 200 a booking's deposit for the team's sheet (S67, AC-X-129), `deposit: null` when it took
   * none; 403 staff; 404 `payments_off`.
   */
  @Get('bookings/:bookingId/deposit')
  @RequirePermission('payments.read')
  async bookingDeposit(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<BookingDepositAnswer> {
    const { bookingId } = parseBody(BookingParamsSchema, params);
    return BookingDepositAnswerSchema.parse({
      deposit: await answering(() => this.payments.bookingDeposit(tenant, bookingId)),
    });
  }

  /**
   * 200 a fresh Stripe-hosted onboarding link (AC-X-96), creating the business's account the
   * first time; 409 `payments_rejected`; 503 `payments_unavailable`; 429; 403 for all but owners.
   */
  @Post('onboarding')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  async onboarding(@CurrentTenant() tenant: TenantContext): Promise<PaymentOnboardingLink> {
    await this.limits.hit(OWNER_CALLS, tenant.tenantId);
    return PaymentOnboardingLinkSchema.parse(
      await answering(() => this.payments.onboarding(tenant)),
    );
  }

  /** 200 the account read again from Stripe (the return page); 503; 429; owners only. */
  @Post('account/sync')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  async sync(@CurrentTenant() tenant: TenantContext): Promise<PaymentAccountAnswer> {
    await this.limits.hit(OWNER_CALLS, tenant.tenantId);
    return PaymentAccountAnswerSchema.parse(await answering(() => this.payments.sync(tenant)));
  }

  /** 200 the Express dashboard's link; 409 `payments_not_onboarded`; 503; 429; owners only. */
  @Post('dashboard')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  async dashboard(@CurrentTenant() tenant: TenantContext): Promise<PaymentDashboardLink> {
    await this.limits.hit(OWNER_CALLS, tenant.tenantId);
    return PaymentDashboardLinkSchema.parse(await answering(() => this.payments.dashboard(tenant)));
  }
}

/** Nest's raw body (`rawBody: true` on the app): the request's exact bytes. */
type WebhookRequest = IncomingMessage & { rawBody?: Buffer };

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Controller('v1/webhooks/stripe')
export class PaymentsWebhookController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly limits: RateLimiter,
  ) {}

  /**
   * Stripe's Connect events (AC-X-98…101): 200 `{ received: true }` once handled, ignored or a
   * redelivery; 401 `webhook_signature_invalid`; 400 `validation_failed`; 500 when handling
   * failed (Stripe delivers again); 404 while payments are off.
   */
  @Post()
  @HttpCode(200)
  @SkipOriginCheck()
  async receive(@Req() request: WebhookRequest): Promise<WebhookAck> {
    await this.limits.hit(DELIVERIES, clientAddress(request));
    return this.payments.receive(request.rawBody, header(request, 'stripe-signature'));
  }
}

/**
 * The sandbox's payments path (AC-X-104): mounted only with `PAYMENTS_PROVIDER=sandbox` where
 * tests run, else this route doesn't exist (404). The signed-in owner moves their sandbox
 * account to a state; a signed event goes through the webhook's own check and handler.
 */
@Controller('v1/dev/payments')
@UseGuards(TenantGuard)
export class PaymentsSandboxController {
  constructor(private readonly payments: PaymentsService) {}

  /** 200 the account after the event; 400; 409 `payments_not_onboarded`; owners only. */
  @Post('account')
  @HttpCode(200)
  @RequirePermission('payments.manage')
  async account(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<PaymentAccountAnswer> {
    const { state } = parseBody(SandboxPaymentRequestSchema, body);
    return PaymentAccountAnswerSchema.parse(
      await answering(() => this.payments.sandboxState(tenant, state)),
    );
  }
}

/**
 * The sandbox's card (S66, AC-X-120): mounted only with `PAYMENTS_PROVIDER=sandbox` where tests
 * run, else 404. The booking page has no session; the payment's client secret is the proof, as
 * it is for Stripe's own field. 204 settled; 400; 404 an unknown secret; 409 already settled.
 */
@Controller('v1/dev/payments/intent')
export class PaymentsSandboxIntentController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly limits: RateLimiter,
  ) {}

  @Post()
  @HttpCode(204)
  async settle(@Body() body: unknown, @Req() request: IncomingMessage): Promise<void> {
    await this.limits.hit(SANDBOX_CARDS, clientAddress(request));
    const { clientSecret, outcome } = parseBody(SandboxIntentRequestSchema, body);
    await answering(() => this.payments.sandboxIntent(clientSecret, outcome));
  }
}

/** Payments. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({})
export class PaymentsModule {
  static forRoot(options: PaymentsOptions): DynamicModule {
    return {
      module: PaymentsModule,
      // The booking page and the team's bookings take deposits through it (S66).
      global: true,
      exports: [PaymentsService],
      controllers: [
        PaymentsController,
        PaymentsWebhookController,
        ...(options.config?.provider === 'sandbox'
          ? [PaymentsSandboxController, PaymentsSandboxIntentController]
          : []),
      ],
      providers: [{ provide: PAYMENTS_OPTIONS, useValue: options }, RateLimiter, PaymentsService],
    };
  }
}
