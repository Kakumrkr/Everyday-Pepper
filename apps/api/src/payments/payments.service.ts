import { randomBytes } from 'node:crypto';
import {
  StripeEventSchema,
  WebhookAckSchema,
  type BookingPaymentStart,
  type PaymentAccountAnswer,
  type PaymentDashboardLink,
  type PaymentOnboardingLink,
  type SandboxPaymentState,
  type WebhookAck,
} from '@pepper/contracts';
import { systemClock, type Actor, type Clock, type TenantContext } from '@pepper/core';
import { findPaymentAccount, withMember, type Database, type TenantTx } from '@pepper/db';
import type { PublicDeposits } from '@pepper/appointments';
import {
  attachBookingPaymentIn,
  chargeableAccountIn,
  requireAuthorizedPayment,
  bookingDepositIn,
  moveDepositWindowIn,
  settleDepositOnCancelIn,
  startBookingPayment,
  type VerifiedPaymentRequest,
  handleStripeEvent,
  paymentDashboardLink,
  PaymentsNotOnboardedError,
  PaymentsProviderError,
  RedisSandboxAccountStore,
  readPaymentAccount,
  SandboxPaymentsProvider,
  startPaymentOnboarding,
  StripePaymentsProvider,
  stripeSignatureHeader,
  syncOwnPaymentAccount,
  verifyStripeSignature,
  type PaymentsDeps,
  type PaymentsProvider,
} from '@pepper/payments';
import {
  currentRequestContext,
  DATABASE,
  REDIS,
  type PaymentsConfig,
  type Redis,
} from '@pepper/runtime';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { apiError } from '../auth/guards.js';

// The api's side of payments (S65, ADR-0067): binds the module's services to this deployment's
// provider, and checks Stripe's webhook before anything in it is read. With payments off every
// call is 404 `payments_off`, so the routes exist and say so.

export interface PaymentsOptions {
  /** `null`: payments are off here. The sandbox only where tests may run (api config). */
  config: PaymentsConfig | null;
  /** Pepper's public origin (`AUTH_BASE_URL`): Stripe's return and refresh pages. */
  baseUrl: string;
  outboxKey: Buffer;
  clock?: Clock;
}

export const PAYMENTS_OPTIONS = Symbol('PAYMENTS_OPTIONS');

interface Bound {
  deps: PaymentsDeps;
  /** The webhook endpoint's signing secret; the sandbox's is made at start-up. */
  webhookSecret: string;
  /** Stripe's publishable key for its card field (S66.2); `null` with the sandbox. */
  publishableKey: string | null;
  sandbox: SandboxPaymentsProvider | null;
}

@Injectable()
export class PaymentsService {
  private readonly bound: Bound | null;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(REDIS) redis: Redis,
    @Inject(PAYMENTS_OPTIONS) options: PaymentsOptions,
  ) {
    this.bound = bind(database.db, redis, options);
  }

  async account(tenant: TenantContext): Promise<PaymentAccountAnswer> {
    return readPaymentAccount(this.on().deps, actorOf(tenant));
  }

  async onboarding(tenant: TenantContext): Promise<PaymentOnboardingLink> {
    return startPaymentOnboarding(this.on().deps, actorOf(tenant));
  }

  async sync(tenant: TenantContext): Promise<PaymentAccountAnswer> {
    return syncOwnPaymentAccount(this.on().deps, actorOf(tenant));
  }

  async dashboard(tenant: TenantContext): Promise<PaymentDashboardLink> {
    return paymentDashboardLink(this.on().deps, actorOf(tenant));
  }

  /**
   * One delivery of Stripe's webhook (AC-X-98…100): the signature over the exact bytes first
   * (401), then the envelope (400), then the event once. A failure to handle it throws (500), so
   * Stripe delivers it again.
   */
  async receive(raw: Buffer | undefined, signature: string | undefined): Promise<WebhookAck> {
    const { deps, webhookSecret } = this.on('webhook_not_found');
    if (
      raw === undefined ||
      !verifyStripeSignature({
        secret: webhookSecret,
        payload: raw,
        header: signature,
        now: deps.clock.now(),
      })
    ) {
      throw new UnauthorizedException(apiError('webhook_signature_invalid'));
    }
    const event = StripeEventSchema.safeParse(parsedJson(raw));
    if (!event.success) throw new BadRequestException(apiError('validation_failed'));
    await handleStripeEvent(deps, event.data);
    return WebhookAckSchema.parse({ received: true });
  }

  /**
   * The sandbox (AC-X-104): moves the signed-in owner's sandbox account to `state`, then
   * delivers a signed event through `receive`, the same path as Stripe's.
   */
  async sandboxState(
    tenant: TenantContext,
    state: SandboxPaymentState,
  ): Promise<PaymentAccountAnswer> {
    const bound = this.on();
    if (bound.sandbox === null) throw new NotFoundException(apiError('payments_off'));
    const row = await withMember(bound.deps.db, tenant, (tx) => findPaymentAccount(tx));
    if (row?.deauthorizedAt !== null) throw new PaymentsNotOnboardedError();
    await bound.sandbox.setState(row.providerAccountId, state);
    const payload = Buffer.from(
      JSON.stringify(sandboxEvent(row.providerAccountId, state, bound.deps.clock.now())),
    );
    await this.receive(
      payload,
      stripeSignatureHeader(bound.webhookSecret, payload, bound.deps.clock.now()),
    );
    return readPaymentAccount(bound.deps, actorOf(tenant));
  }

  // ---- Deposits (S66, ADR-0068) ----

  /**
   * What the booking page asks of payments (AC-X-113…117); `undefined` while payments are off,
   * so deposit services can't be booked online.
   */
  publicDeposits(): PublicDeposits | undefined {
    const bound = this.bound;
    if (bound === null) return undefined;
    const { deps } = bound;
    return {
      open: async (tx) => (await chargeableAccountIn(tx, deps.provider)) !== undefined,
      ready: (tenantId, requestId) => requireAuthorizedPayment(deps, tenantId, requestId),
      attach: (tx, input) => attachBookingPaymentIn(tx, { ...input, outboxKey: deps.outboxKey }),
      cancelled: async (tx, input) => {
        await settleDepositOnCancelIn(tx, { ...input, outboxKey: deps.outboxKey });
      },
      rescheduled: (tx, input) => moveDepositWindowIn(tx, { ...input, by: 'client' }),
      describe: (tx, input) => bookingDepositIn(tx, input),
    };
  }

  /** The team's move (AC-X-117): a deposit's refund window follows the new time. */
  teamMoved():
    ((tx: TenantTx, booking: { bookingId: string; startsAt: Date }) => Promise<void>) | undefined {
    const bound = this.bound;
    if (bound === null) return undefined;
    const { deps } = bound;
    return (tx, booking) =>
      moveDepositWindowIn(tx, { ...booking, by: 'business', now: deps.clock.now() });
  }

  /** The team's cancel (AC-X-118): a paid deposit is refunded in full, in the cancel's transaction. */
  teamCancelled():
    ((tx: TenantTx, booking: { bookingId: string; startsAt: Date }) => Promise<void>) | undefined {
    const bound = this.bound;
    if (bound === null) return undefined;
    const { deps } = bound;
    return async (tx, booking) => {
      await settleDepositOnCancelIn(tx, {
        ...booking,
        by: 'business',
        now: deps.clock.now(),
        outboxKey: deps.outboxKey,
      });
    };
  }

  /** `POST …/booking-requests/:id/payment` (AC-X-114), once the code was checked. */
  startPayment(request: VerifiedPaymentRequest): Promise<BookingPaymentStart> {
    const bound = this.on();
    return startBookingPayment({ ...bound.deps, publishableKey: bound.publishableKey }, request);
  }

  /** The sandbox's card (AC-X-120): settles a payment by its client secret; 404 elsewhere. */
  async sandboxIntent(clientSecret: string, outcome: 'succeeded' | 'declined'): Promise<void> {
    const bound = this.on();
    if (bound.sandbox === null) throw new NotFoundException(apiError('payments_off'));
    try {
      await bound.sandbox.settleIntent(clientSecret, outcome);
    } catch (error) {
      // The sandbox's own refusals: no such payment (404), or one already settled (409).
      if (!(error instanceof PaymentsProviderError)) throw error;
      if (error.status === 404) throw new NotFoundException(apiError('validation_failed'));
      throw new ConflictException(apiError('validation_failed'));
    }
  }

  private on(code: 'payments_off' | 'webhook_not_found' = 'payments_off'): Bound {
    if (this.bound === null) throw new NotFoundException(apiError(code));
    return this.bound;
  }
}

function bind(db: Database, redis: Redis, options: PaymentsOptions): Bound | null {
  const { config } = options;
  if (config === null) return null;
  const clock = options.clock ?? systemClock;
  let provider: PaymentsProvider;
  let sandbox: SandboxPaymentsProvider | null = null;
  let webhookSecret: string;
  let publishableKey: string | null = null;
  if (config.provider === 'sandbox') {
    sandbox = new SandboxPaymentsProvider({
      store: new RedisSandboxAccountStore(redis),
      baseUrl: options.baseUrl,
      now: () => clock.now(),
    });
    provider = sandbox;
    // Only this process signs and checks the sandbox's events.
    webhookSecret = `whsec_sandbox${randomBytes(24).toString('hex')}`;
  } else {
    provider = new StripePaymentsProvider({ secretKey: config.secretKey });
    webhookSecret = config.webhookSecret;
    publishableKey = config.publishableKey;
  }
  return {
    deps: { db, provider, clock, outboxKey: options.outboxKey, baseUrl: options.baseUrl },
    webhookSecret,
    publishableKey,
    sandbox,
  };
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}

function parsedJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return null;
  }
}

/** The event Stripe would send for a sandbox account moved to `state`. */
function sandboxEvent(account: string, state: SandboxPaymentState, now: Date) {
  return {
    id: `evt_sandbox${randomBytes(12).toString('hex')}`,
    object: 'event',
    api_version: null,
    account,
    created: Math.floor(now.getTime() / 1000),
    livemode: false,
    pending_webhooks: 1,
    type: state === 'deauthorized' ? 'account.application.deauthorized' : 'account.updated',
    data: { object: { id: account, object: state === 'deauthorized' ? 'application' : 'account' } },
  };
}
