import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

// Payments (S65, ADR-0067): the business's Stripe Connect Express account, where it stands, and
// the parts of Stripe's answers and webhook events Pepper reads. Stripe sends more fields than
// these; the schemas keep only what Pepper uses and validate it, because every answer and every
// event is outside input. Nothing here carries a card, a bank account or a person's details:
// Stripe's own pages collect those.

/** Where payments go: Stripe, or the sandbox that never leaves the machine (ADR-0067 §1, §8). */
export const PaymentProviderSchema = z.enum(['stripe', 'sandbox']);
export type PaymentProvider = z.infer<typeof PaymentProviderSchema>;

/** A connected account's id (`acct_…`); the sandbox's look the same. */
export const StripeAccountIdSchema = z.string().regex(/^acct_[A-Za-z0-9]{1,64}$/);
export type StripeAccountId = z.infer<typeof StripeAccountIdSchema>;

/** A webhook event's id (`evt_…`), the key that makes each event count once (AC-X-99). */
export const StripeEventIdSchema = z.string().regex(/^evt_[A-Za-z0-9_]{1,100}$/);
export type StripeEventId = z.infer<typeof StripeEventIdSchema>;

/**
 * One thing Stripe still needs, as its code (`external_account`, `individual.verification.document`,
 * `person_1Abc.dob.day`): printable ASCII without spaces. The screen words it (S65.2).
 */
export const PaymentRequirementSchema = z.string().regex(/^[\x21-\x7e]{1,200}$/);

/** At most this many codes of each kind are kept; Stripe asks for far fewer. */
export const PAYMENT_REQUIREMENTS_MAX = 100;

const RequirementListSchema = z
  .array(PaymentRequirementSchema)
  .transform((codes) => [...new Set(codes)].slice(0, PAYMENT_REQUIREMENTS_MAX));

/** Why Stripe disabled the account (`requirements.past_due`, `rejected.fraud`, `under_review`…). */
export const PaymentDisabledReasonSchema = z.string().regex(/^[a-z_.]{1,100}$/);

/** What Pepper keeps of a connected account, as Stripe last answered it. */
export const PaymentAccountSnapshotSchema = z
  .object({
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
    currentlyDue: z.array(PaymentRequirementSchema).max(PAYMENT_REQUIREMENTS_MAX),
    pastDue: z.array(PaymentRequirementSchema).max(PAYMENT_REQUIREMENTS_MAX),
    eventuallyDue: z.array(PaymentRequirementSchema).max(PAYMENT_REQUIREMENTS_MAX),
    pendingVerification: z.array(PaymentRequirementSchema).max(PAYMENT_REQUIREMENTS_MAX),
    /** When the codes currently due must be in, else Stripe disables more. */
    currentDeadline: UtcDateTimeSchema.nullable(),
    disabledReason: PaymentDisabledReasonSchema.nullable(),
  })
  .strict();
export type PaymentAccountSnapshot = z.infer<typeof PaymentAccountSnapshotSchema>;

/**
 * Where payments stand, in one word (ADR-0067 §5):
 * - `not_connected`: no Stripe account yet, or Stripe disconnected it;
 * - `onboarding`: the owner hasn't finished Stripe's pages;
 * - `pending`: Stripe is checking what the owner sent;
 * - `action_needed`: Stripe needs something more (or paused the account for another reason);
 * - `ready`: payments and payouts are on, nothing is due;
 * - `rejected`: Stripe won't work with the business (`rejected.*`).
 */
export const PaymentAccountStatusSchema = z.enum([
  'not_connected',
  'onboarding',
  'pending',
  'action_needed',
  'ready',
  'rejected',
]);
export type PaymentAccountStatus = z.infer<typeof PaymentAccountStatusSchema>;

/** Disabled while Stripe checks, not for anything the owner must do. */
const WAITING_ON_STRIPE: ReadonlySet<string> = new Set([
  'requirements.pending_verification',
  'under_review',
]);

/**
 * The status of a stored account (`null`: none). Pure, so the screen, the push and the api agree;
 * the order matters: a rejection outranks everything, then unfinished onboarding, then anything
 * due, then whether Stripe has switched payments on.
 */
export function paymentAccountStatus(
  account: (PaymentAccountSnapshot & { deauthorized: boolean }) | null,
): PaymentAccountStatus {
  if (account === null || account.deauthorized) return 'not_connected';
  const reason = account.disabledReason;
  if (reason?.startsWith('rejected.') === true) return 'rejected';
  if (!account.detailsSubmitted) return 'onboarding';
  if (account.pastDue.length > 0 || account.currentlyDue.length > 0) return 'action_needed';
  if (account.chargesEnabled && account.payoutsEnabled) return 'ready';
  if (reason === null || WAITING_ON_STRIPE.has(reason) || account.pendingVerification.length > 0) {
    return 'pending';
  }
  return 'action_needed';
}

/** `GET /v1/payments/account` (AC-X-97): owners and managers. */
export const PaymentAccountAnswerSchema = z
  .object({
    status: PaymentAccountStatusSchema,
    /** Whether the business can take payments (deposits, S66) and get payouts. */
    chargesEnabled: z.boolean(),
    payoutsEnabled: z.boolean(),
    detailsSubmitted: z.boolean(),
    /** What Stripe needs now (past due first), and what it will need later. */
    due: z.array(PaymentRequirementSchema),
    eventuallyDue: z.array(PaymentRequirementSchema),
    dueBy: UtcDateTimeSchema.nullable(),
    disabledReason: PaymentDisabledReasonSchema.nullable(),
    /** When Pepper last read the account from Stripe; `null` with no account. */
    syncedAt: UtcDateTimeSchema.nullable(),
    /** Whether this reader may connect, sync or open the dashboard (the owner). */
    canManage: z.boolean(),
  })
  .strict();
export type PaymentAccountAnswer = z.infer<typeof PaymentAccountAnswerSchema>;

/** `POST /v1/payments/onboarding` (AC-X-96): Stripe's single-use page, valid for minutes. */
export const PaymentOnboardingLinkSchema = z
  .object({ url: z.url({ protocol: /^https?$/ }), expiresAt: UtcDateTimeSchema })
  .strict();
export type PaymentOnboardingLink = z.infer<typeof PaymentOnboardingLinkSchema>;

/** `POST /v1/payments/dashboard`: the Express dashboard, for payouts and the bank account. */
export const PaymentDashboardLinkSchema = z
  .object({ url: z.url({ protocol: /^https?$/ }) })
  .strict();
export type PaymentDashboardLink = z.infer<typeof PaymentDashboardLinkSchema>;

/** The states `POST /v1/dev/payments/account` puts the sandbox account in (AC-X-104). */
export const SandboxPaymentStateSchema = z.enum([
  'onboarding',
  'pending',
  'action_needed',
  'ready',
  'rejected',
  'deauthorized',
]);
export type SandboxPaymentState = z.infer<typeof SandboxPaymentStateSchema>;

export const SandboxPaymentRequestSchema = z.object({ state: SandboxPaymentStateSchema }).strict();

// ---- Stripe's own shapes (API version pinned in the adapter, ADR-0067 §2) ----

/** Seconds since the epoch, as Stripe sends times; at least 2010, at most 2100. */
const StripeTimestampSchema = z.number().int().min(1_262_304_000).max(4_102_444_800);

/** `requirements` of an account (only the fields Pepper keeps). */
const StripeRequirementsSchema = z.object({
  currently_due: RequirementListSchema.nullish(),
  past_due: RequirementListSchema.nullish(),
  eventually_due: RequirementListSchema.nullish(),
  pending_verification: RequirementListSchema.nullish(),
  current_deadline: StripeTimestampSchema.nullish(),
  disabled_reason: PaymentDisabledReasonSchema.nullish(),
});

/** An account as `GET /v1/accounts/{id}` and `POST /v1/accounts` answer it. */
export const StripeAccountSchema = z.object({
  id: StripeAccountIdSchema,
  object: z.literal('account'),
  charges_enabled: z.boolean().nullish(),
  payouts_enabled: z.boolean().nullish(),
  details_submitted: z.boolean().nullish(),
  requirements: StripeRequirementsSchema.nullish(),
});
export type StripeAccount = z.infer<typeof StripeAccountSchema>;

/** What Pepper keeps of Stripe's answer: missing flags read as off, missing lists as empty. */
export function snapshotOfStripeAccount(account: StripeAccount): PaymentAccountSnapshot {
  const requirements = account.requirements ?? {};
  const deadline = requirements.current_deadline;
  return PaymentAccountSnapshotSchema.parse({
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
    currentlyDue: requirements.currently_due ?? [],
    pastDue: requirements.past_due ?? [],
    eventuallyDue: requirements.eventually_due ?? [],
    pendingVerification: requirements.pending_verification ?? [],
    currentDeadline:
      deadline === undefined || deadline === null ? null : new Date(deadline * 1000).toISOString(),
    disabledReason: requirements.disabled_reason ?? null,
  });
}

/** `POST /v1/account_links`: the onboarding page and when it stops working. */
export const StripeAccountLinkSchema = z.object({
  object: z.literal('account_link'),
  url: z.url({ protocol: /^https$/ }),
  expires_at: StripeTimestampSchema,
});

/** `POST /v1/accounts/{id}/login_links`: the Express dashboard. */
export const StripeLoginLinkSchema = z.object({
  object: z.literal('login_link'),
  url: z.url({ protocol: /^https$/ }),
});

/** Stripe's error answer (`error.type`, `error.code`); the message is never kept. */
export const StripeErrorSchema = z.object({
  error: z.object({
    type: z.string().max(60),
    code: z.string().max(100).nullish(),
  }),
});

/** The event types Pepper acts on; any other is acknowledged and ignored (AC-X-100). */
export const HANDLED_STRIPE_EVENTS = [
  'account.updated',
  'capability.updated',
  'account.application.deauthorized',
] as const;
export type HandledStripeEventType = (typeof HANDLED_STRIPE_EVENTS)[number];

export function isHandledStripeEvent(type: string): type is HandledStripeEventType {
  return (HANDLED_STRIPE_EVENTS as readonly string[]).includes(type);
}

/**
 * A webhook event's envelope (Connect endpoints: `account` names the connected account). Only the
 * envelope is trusted, and only after the signature: what changed is read from Stripe again.
 */
export const StripeEventSchema = z.object({
  id: StripeEventIdSchema,
  object: z.literal('event'),
  type: z.string().regex(/^[a-z0-9_.]{1,100}$/),
  created: StripeTimestampSchema,
  livemode: z.boolean(),
  account: StripeAccountIdSchema.nullish(),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;
