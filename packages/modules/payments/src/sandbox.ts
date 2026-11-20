import { createHash, randomBytes } from 'node:crypto';
import {
  StripeAccountSchema,
  type SandboxPaymentState,
  type StripeAccount,
  type StripeAccountId,
} from '@pepper/contracts';
import {
  PaymentsProviderError,
  type CreateAccountInput,
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
}
