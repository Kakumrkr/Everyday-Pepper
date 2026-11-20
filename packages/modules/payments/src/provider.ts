import type { PaymentProvider, StripeAccount, StripeAccountId, TenantId } from '@pepper/contracts';

// The payments port (S65, ADR-0067 §1): what the services ask of Stripe. `StripePaymentsProvider`
// calls Stripe's API; `SandboxPaymentsProvider` never leaves the machine. Callers never hold a
// database transaction open across a call.

export interface CreateAccountInput {
  tenantId: TenantId;
  /** Stripe replays the first answer for the same key (24 h): one account per business. */
  idempotencyKey: string;
}

export interface OnboardingLinkInput {
  accountId: StripeAccountId;
  /** Where Stripe sends the owner when they finish (or leave) its pages. */
  returnUrl: string;
  /** Where Stripe sends the owner when the link expired or was used: Pepper makes a new one. */
  refreshUrl: string;
}

export interface ProviderLink {
  url: string;
  /** `null`: Stripe gives no expiry (dashboard links are single-use). */
  expiresAt: Date | null;
}

export interface PaymentsProvider {
  readonly provider: PaymentProvider;
  /** Whether the key is live: an event of the other mode changes nothing (AC-X-97). */
  readonly livemode: boolean;
  createAccount(input: CreateAccountInput): Promise<StripeAccount>;
  retrieveAccount(accountId: StripeAccountId): Promise<StripeAccount>;
  createOnboardingLink(input: OnboardingLinkInput): Promise<ProviderLink>;
  createDashboardLink(accountId: StripeAccountId): Promise<ProviderLink>;
}

/**
 * Stripe refused or failed a call. `retryable`: throttling, Stripe's own trouble, a timeout or
 * the network (the webhook answers 500 and Stripe delivers again; the owner can tap again).
 * Never carries Stripe's message (it can echo the business's details).
 */
export class PaymentsProviderError extends Error {
  constructor(
    readonly status: number | null,
    readonly type: string | null,
    readonly code: string | null,
    readonly retryable: boolean,
  ) {
    super(
      `Payments provider refused the call (${status === null ? 'no answer' : String(status)}${
        type === null ? '' : ` ${type}`
      }${code === null ? '' : `/${code}`})`,
    );
    this.name = 'PaymentsProviderError';
  }
}

/** Whether a Stripe answer's status is worth trying again (ADR-0067 §2). */
export function isRetryableStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}
