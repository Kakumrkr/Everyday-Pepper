import type {
  PaymentProvider,
  StripeAccount,
  StripeAccountId,
  StripeCustomerId,
  StripePaymentIntent,
  StripeRefund,
  StripeSetupIntent,
  TenantId,
} from '@pepper/contracts';

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

/** A client Stripe keeps a card for (S66): on the platform, named by the business's request. */
export interface CreateCustomerInput {
  tenantId: TenantId;
  /** The client's address and name, for Stripe's receipts and a dispute's evidence. */
  email: string;
  name: string;
  idempotencyKey: string;
}

/**
 * A deposit (S66, ADR-0068 §3): a destination charge on the business's behalf, authorized now and
 * captured once booked, the card kept for later (`setup_future_usage=off_session`).
 */
export interface CreateDepositInput {
  tenantId: TenantId;
  requestId: string;
  accountId: StripeAccountId;
  customerId: StripeCustomerId;
  amountCents: number;
  /** On the client's statement and receipt: the business and the service. */
  description: string;
  idempotencyKey: string;
}

/** A card kept for later with nothing paid now (S66): a SetupIntent on the business's behalf. */
export interface CreateCardSetupInput {
  tenantId: TenantId;
  requestId: string;
  accountId: StripeAccountId;
  customerId: StripeCustomerId;
  idempotencyKey: string;
}

export interface PaymentsProvider {
  readonly provider: PaymentProvider;
  /** Whether the key is live: an event of the other mode changes nothing (AC-X-100). */
  readonly livemode: boolean;
  createAccount(input: CreateAccountInput): Promise<StripeAccount>;
  retrieveAccount(accountId: StripeAccountId): Promise<StripeAccount>;
  createOnboardingLink(input: OnboardingLinkInput): Promise<ProviderLink>;
  createDashboardLink(accountId: StripeAccountId): Promise<ProviderLink>;
  // Deposits and cards on file (S66, ADR-0068). Every POST carries the caller's key.
  createCustomer(input: CreateCustomerInput): Promise<{ id: StripeCustomerId }>;
  createDeposit(input: CreateDepositInput): Promise<StripePaymentIntent>;
  createCardSetup(input: CreateCardSetupInput): Promise<StripeSetupIntent>;
  retrievePaymentIntent(id: string): Promise<StripePaymentIntent>;
  retrieveSetupIntent(id: string): Promise<StripeSetupIntent>;
  /** Takes the authorized amount (after the booking committed). */
  capturePaymentIntent(id: string, idempotencyKey: string): Promise<StripePaymentIntent>;
  /** Lets an authorization go: nothing was taken (nobody booked with it). */
  cancelPaymentIntent(id: string, idempotencyKey: string): Promise<StripePaymentIntent>;
  /** The whole payment back to the client, the transfer to the business reversed. */
  createRefund(paymentIntentId: string, idempotencyKey: string): Promise<StripeRefund>;
  retrieveRefund(id: string): Promise<StripeRefund>;
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
