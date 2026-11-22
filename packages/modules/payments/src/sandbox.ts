import { createHash, randomBytes } from 'node:crypto';
import {
  StripeAccountSchema,
  StripePaymentIntentSchema,
  StripeRefundSchema,
  StripeSetupIntentSchema,
  type SandboxPaymentState,
  type StripeAccount,
  type StripeAccountId,
  type StripeCustomerId,
  type StripePaymentIntent,
  type StripeRefund,
  type StripeSetupIntent,
} from '@pepper/contracts';
import {
  PaymentsProviderError,
  type CreateAccountInput,
  type CreateCardSetupInput,
  type CreateCustomerInput,
  type CreateDepositInput,
  type OnboardingLinkInput,
  type PaymentsProvider,
  type ProviderLink,
} from './provider.js';

// The sandbox (S65, ADR-0067 §8, AC-X-104): `PaymentsProvider` without Stripe, for tests and
// S65.2's journeys. Accounts live in a store (Redis for a day where the api runs, memory in unit
// tests); the onboarding link goes straight back to Pepper's return page; `setState` moves an
// account to what a journey needs. Nothing leaves the machine.

/** Where the sandbox keeps its accounts. */
export interface SandboxAccountStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** For unit tests and a single process. */
export class MemorySandboxAccountStore implements SandboxAccountStore {
  private readonly values = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const SANDBOX_TTL_SECONDS = 24 * 60 * 60;

/** The api's: shared across requests and restarts, kept a day. */
export class RedisSandboxAccountStore implements SandboxAccountStore {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    },
  ) {}
  get(key: string): Promise<string | null> {
    return this.redis.get(`pepper:payments-sandbox:${key}`);
  }
  async set(key: string, value: string): Promise<void> {
    await this.redis.set(`pepper:payments-sandbox:${key}`, value, 'EX', SANDBOX_TTL_SECONDS);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** What Stripe would answer for an account in `state`, at `now`. */
export function sandboxAccount(
  id: StripeAccountId,
  state: Exclude<SandboxPaymentState, 'deauthorized'>,
  now: Date,
): StripeAccount {
  const none = { currently_due: [], past_due: [], eventually_due: [], pending_verification: [] };
  const answers: Record<typeof state, Omit<StripeAccount, 'id' | 'object'>> = {
    onboarding: {
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: false,
      requirements: {
        ...none,
        currently_due: ['external_account', 'tos_acceptance.date'],
        eventually_due: ['external_account', 'tos_acceptance.date'],
        disabled_reason: 'requirements.past_due',
        current_deadline: null,
      },
    },
    pending: {
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        ...none,
        pending_verification: ['individual.verification.document'],
        disabled_reason: 'requirements.pending_verification',
        current_deadline: null,
      },
    },
    action_needed: {
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      requirements: {
        ...none,
        currently_due: ['individual.verification.document'],
        eventually_due: ['individual.verification.document'],
        disabled_reason: null,
        current_deadline: Math.floor((now.getTime() + 14 * DAY_MS) / 1000),
      },
    },
    ready: {
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      requirements: { ...none, disabled_reason: null, current_deadline: null },
    },
    rejected: {
      charges_enabled: false,
      payouts_enabled: false,
      details_submitted: true,
      requirements: { ...none, disabled_reason: 'rejected.other', current_deadline: null },
    },
  };
  return StripeAccountSchema.parse({ id, object: 'account', ...answers[state] });
}

export interface SandboxOptions {
  store: SandboxAccountStore;
  /** Pepper's public origin: the dashboard link opens a page there. */
  baseUrl: string;
  now?: () => Date;
}

export class SandboxPaymentsProvider implements PaymentsProvider {
  readonly provider = 'sandbox' as const;
  readonly livemode = false;
  private readonly now: () => Date;

  constructor(private readonly options: SandboxOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async createAccount(input: CreateAccountInput): Promise<StripeAccount> {
    // As Stripe does: the same key answers the same account.
    const keyed = `key:${createHash('sha256').update(input.idempotencyKey).digest('hex')}`;
    const existing = await this.options.store.get(keyed);
    if (existing !== null) return this.retrieveAccount(existing);
    const id = `acct_sandbox${randomBytes(8).toString('hex')}`;
    await this.save(sandboxAccount(id, 'onboarding', this.now()));
    await this.options.store.set(keyed, id);
    return this.retrieveAccount(id);
  }

  async retrieveAccount(accountId: StripeAccountId): Promise<StripeAccount> {
    const stored = await this.options.store.get(`account:${accountId}`);
    // As Stripe answers for an account the platform can no longer read.
    if (stored === null || stored === 'deauthorized') {
      throw new PaymentsProviderError(403, 'invalid_request_error', 'account_invalid', false);
    }
    return StripeAccountSchema.parse(JSON.parse(stored));
  }

  async createOnboardingLink(input: OnboardingLinkInput): Promise<ProviderLink> {
    await this.retrieveAccount(input.accountId);
    return { url: input.returnUrl, expiresAt: new Date(this.now().getTime() + 5 * 60 * 1000) };
  }

  async createDashboardLink(accountId: StripeAccountId): Promise<ProviderLink> {
    await this.retrieveAccount(accountId);
    return { url: `${this.options.baseUrl}/more/payments?sandbox=dashboard`, expiresAt: null };
  }

  /** Moves an account to `state` (the dev route, before it delivers a signed event). */
  async setState(accountId: StripeAccountId, state: SandboxPaymentState): Promise<void> {
    if (state === 'deauthorized') {
      await this.options.store.set(`account:${accountId}`, 'deauthorized');
      return;
    }
    await this.save(sandboxAccount(accountId, state, this.now()));
  }

  private async save(account: StripeAccount): Promise<void> {
    await this.options.store.set(`account:${account.id}`, JSON.stringify(account));
  }

  // ---- Deposits and cards (S66, ADR-0068 §8): Stripe's answers, kept in the store ----

  /** As Stripe does: the same key answers what it made the first time. */
  private async once<T>(
    key: string,
    make: () => Promise<{ id: string; value: T }>,
    read: (id: string) => Promise<T>,
  ): Promise<T> {
    const keyed = `key:${createHash('sha256').update(key).digest('hex')}`;
    const existing = await this.options.store.get(keyed);
    if (existing !== null) return read(existing);
    const made = await make();
    await this.options.store.set(keyed, made.id);
    return made.value;
  }

  async createCustomer(input: CreateCustomerInput): Promise<{ id: StripeCustomerId }> {
    return this.once(
      input.idempotencyKey,
      () => {
        const id = `cus_sandbox${randomBytes(8).toString('hex')}`;
        return Promise.resolve({ id, value: { id } });
      },
      (id) => Promise.resolve({ id }),
    );
  }

  async createDeposit(input: CreateDepositInput): Promise<StripePaymentIntent> {
    await this.retrieveAccount(input.accountId);
    return this.once(
      input.idempotencyKey,
      async () => {
        const id = `pi_sandbox${randomBytes(8).toString('hex')}`;
        const intent = StripePaymentIntentSchema.parse({
          id,
          object: 'payment_intent',
          amount: input.amountCents,
          amount_received: 0,
          currency: 'usd',
          customer: input.customerId,
          status: 'requires_payment_method',
          client_secret: `${id}_secret_${randomBytes(12).toString('hex')}`,
          livemode: false,
        });
        await this.keep(intent);
        return { id, value: intent };
      },
      (id) => this.retrievePaymentIntent(id),
    );
  }

  async createCardSetup(input: CreateCardSetupInput): Promise<StripeSetupIntent> {
    await this.retrieveAccount(input.accountId);
    return this.once(
      input.idempotencyKey,
      async () => {
        const id = `seti_sandbox${randomBytes(8).toString('hex')}`;
        const intent = StripeSetupIntentSchema.parse({
          id,
          object: 'setup_intent',
          customer: input.customerId,
          status: 'requires_payment_method',
          client_secret: `${id}_secret_${randomBytes(12).toString('hex')}`,
          livemode: false,
        });
        await this.keep(intent);
        return { id, value: intent };
      },
      (id) => this.retrieveSetupIntent(id),
    );
  }

  async retrievePaymentIntent(id: string): Promise<StripePaymentIntent> {
    return StripePaymentIntentSchema.parse(await this.stored(`intent:${id}`));
  }

  async retrieveSetupIntent(id: string): Promise<StripeSetupIntent> {
    return StripeSetupIntentSchema.parse(await this.stored(`intent:${id}`));
  }

  async capturePaymentIntent(id: string, idempotencyKey: string): Promise<StripePaymentIntent> {
    return this.once(
      idempotencyKey,
      async () => {
        const intent = await this.retrievePaymentIntent(id);
        if (intent.status !== 'requires_capture') throw refused('payment_intent_unexpected_state');
        const captured = {
          ...intent,
          status: 'succeeded' as const,
          amount_received: intent.amount,
        };
        await this.keep(captured);
        return { id, value: captured };
      },
      (captured) => this.retrievePaymentIntent(captured),
    );
  }

  async cancelPaymentIntent(id: string, idempotencyKey: string): Promise<StripePaymentIntent> {
    return this.once(
      idempotencyKey,
      async () => {
        const intent = await this.retrievePaymentIntent(id);
        if (intent.status === 'succeeded' || intent.status === 'canceled') {
          throw refused('payment_intent_unexpected_state');
        }
        const canceled = { ...intent, status: 'canceled' as const };
        await this.keep(canceled);
        return { id, value: canceled };
      },
      (canceled) => this.retrievePaymentIntent(canceled),
    );
  }

  async createRefund(paymentIntentId: string, idempotencyKey: string): Promise<StripeRefund> {
    return this.once(
      idempotencyKey,
      async () => {
        const intent = await this.retrievePaymentIntent(paymentIntentId);
        if (intent.status !== 'succeeded') throw refused('charge_already_refunded');
        const id = `re_sandbox${randomBytes(8).toString('hex')}`;
        const refund = StripeRefundSchema.parse({
          id,
          object: 'refund',
          amount: intent.amount,
          status: 'succeeded',
        });
        await this.options.store.set(`refund:${id}`, JSON.stringify(refund));
        return { id, value: refund };
      },
      (id) => this.retrieveRefund(id),
    );
  }

  async retrieveRefund(id: string): Promise<StripeRefund> {
    return StripeRefundSchema.parse(await this.stored(`refund:${id}`));
  }

  /**
   * Settles an intent as Stripe's field would after the client typed a card (the dev route,
   * AC-X-120): `succeeded` authorizes a payment (or saves a setup's card); `declined` leaves it
   * waiting for another card. The client secret is the proof, as it is for Stripe.js.
   */
  async settleIntent(clientSecret: string, outcome: 'succeeded' | 'declined'): Promise<void> {
    const id = /^((?:pi|seti)_[A-Za-z0-9]+)_secret_/.exec(clientSecret)?.[1];
    const raw = id === undefined ? null : await this.options.store.get(`intent:${id}`);
    if (raw === null) throw refused('resource_missing', 404);
    const intent = StripePaymentIntentSchema.or(StripeSetupIntentSchema).parse(JSON.parse(raw));
    if (intent.client_secret !== clientSecret) throw refused('resource_missing', 404);
    if (intent.status !== 'requires_payment_method') throw refused('unexpected_state');
    if (outcome === 'declined') return;
    await this.keep(
      intent.object === 'payment_intent'
        ? { ...intent, status: 'requires_capture' }
        : { ...intent, status: 'succeeded' },
    );
  }

  private async keep(intent: StripePaymentIntent | StripeSetupIntent): Promise<void> {
    await this.options.store.set(`intent:${intent.id}`, JSON.stringify(intent));
  }

  private async stored(key: string): Promise<unknown> {
    const raw = await this.options.store.get(key);
    if (raw === null) throw refused('resource_missing', 404);
    return JSON.parse(raw);
  }
}

/** What Stripe answers for a call it won't do: not worth trying again. */
function refused(code: string, status = 400): PaymentsProviderError {
  return new PaymentsProviderError(status, 'invalid_request_error', code, false);
}
