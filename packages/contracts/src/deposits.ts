import { z } from 'zod';

// Deposits and card on file (S66, ADR-0068): the rule a service carries, the business's refund
// window, the terms the booking page shows, and the parts of Stripe's customers, intents and
// refunds Pepper reads. Nothing here carries a card: Stripe's hosted field takes it, and Pepper
// only ever holds Stripe's ids and the client secret it hands to that field.

/** The smallest card charge Stripe takes in USD: 50 cents. */
export const MIN_DEPOSIT_CENTS = 50;
/** The longest refund window: a week. */
export const MAX_DEPOSIT_REFUND_HOURS = 168;
/** The window a business starts with (D-4). */
export const DEFAULT_DEPOSIT_REFUND_HOURS = 24;

/**
 * What a service asks for when it is booked online (AC-X-111): nothing; a fixed amount in cents;
 * a percent of its starting price (rounded to the cent); or a card on file with nothing paid now.
 */
export const DepositRuleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('fixed'),
      amountCents: z.number().int().min(MIN_DEPOSIT_CENTS).max(10_000_000),
    })
    .strict(),
  z.object({ kind: z.literal('percent'), percent: z.number().int().min(1).max(100) }).strict(),
  z.object({ kind: z.literal('card') }).strict(),
]);
export type DepositRule = z.infer<typeof DepositRuleSchema>;

export const DepositKindSchema = z.enum(['none', 'fixed', 'percent', 'card']);
export type DepositKind = z.infer<typeof DepositKindSchema>;

/** Hours before the start a client may cancel and get the deposit back (AC-X-112). */
export const DepositRefundHoursSchema = z.number().int().min(0).max(MAX_DEPOSIT_REFUND_HOURS);

/**
 * Why a rule doesn't fit a service's price, or `null` when it does (AC-X-111): a fixed amount
 * above the starting price, or a percent of a service with no price.
 */
export function depositRuleProblem(
  rule: DepositRule,
  priceFromCents: number | null,
): { path: string; message: string } | null {
  if (rule.kind === 'fixed' && priceFromCents !== null && rule.amountCents > priceFromCents) {
    return { path: 'amountCents', message: 'The deposit can be at most the price' };
  }
  if (rule.kind === 'percent' && priceFromCents === null) {
    return { path: 'percent', message: 'A percent deposit needs a price' };
  }
  if (rule.kind === 'percent' && depositCentsOf(rule, priceFromCents) < MIN_DEPOSIT_CENTS) {
    return { path: 'percent', message: 'That comes to less than $0.50' };
  }
  return null;
}

/** The cents a rule takes now from a service at `priceFromCents` (0 for none or card). */
export function depositCentsOf(rule: DepositRule, priceFromCents: number | null): number {
  if (rule.kind === 'fixed') return rule.amountCents;
  if (rule.kind === 'percent') return Math.round(((priceFromCents ?? 0) * rule.percent) / 100);
  return 0;
}

/**
 * What the client agrees to when booking a service online (AC-X-113): a deposit paid now, or a
 * card kept for later, each with the refund window; `null` when the service asks for nothing.
 */
export const DepositTermsSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('deposit'),
      amountCents: z.number().int().min(MIN_DEPOSIT_CENTS),
      refundHours: DepositRefundHoursSchema,
    })
    .strict(),
  z.object({ kind: z.literal('card'), refundHours: DepositRefundHoursSchema }).strict(),
]);
export type DepositTerms = z.infer<typeof DepositTermsSchema>;

/**
 * The terms of a service's rule (ADR-0068 §2): computed again whenever a payment is made, never
 * taken from the page. A rule that no longer fits the price (the price changed) asks nothing.
 */
export function depositTermsOf(
  rule: DepositRule,
  priceFromCents: number | null,
  refundHours: number,
): DepositTerms | null {
  if (rule.kind === 'none') return null;
  if (rule.kind === 'card') return { kind: 'card', refundHours };
  const amountCents = depositCentsOf(rule, priceFromCents);
  if (amountCents < MIN_DEPOSIT_CENTS || depositRuleProblem(rule, priceFromCents) !== null) {
    return null;
  }
  return { kind: 'deposit', amountCents, refundHours };
}

/** The last moment a client's cancel gets the deposit back, for a visit at `startsAt` (S66 top-up). */
export function depositRefundEndsAt(startsAt: Date | string, refundHours: number): Date {
  const start = typeof startsAt === 'string' ? Date.parse(startsAt) : startsAt.getTime();
  return new Date(start - refundHours * 60 * 60 * 1000);
}

/** Whether a client cancelling at `now` gets the deposit back (AC-X-117). */
export function isRefundable(startsAt: Date, refundHours: number, now: Date): boolean {
  return now.getTime() <= depositRefundEndsAt(startsAt, refundHours).getTime();
}

/**
 * Where a booking's payment stands (ADR-0068 §6): made and waiting for the card (`started`);
 * booked with the card authorized (`booked`), then `captured`; a card kept with nothing paid
 * (`card_saved`); after a cancel, `kept`, `refund_pending`, `refunded` or `refund_failed`; nobody
 * booked with it (`voided`); the capture refused for good (`capture_failed`).
 */
export const BookingPaymentStatusSchema = z.enum([
  'started',
  'booked',
  'captured',
  'card_saved',
  'kept',
  'refund_pending',
  'refunded',
  'refund_failed',
  'voided',
  'capture_failed',
]);
export type BookingPaymentStatus = z.infer<typeof BookingPaymentStatusSchema>;

export const BookingPaymentKindSchema = z.enum(['deposit', 'card']);
export type BookingPaymentKind = z.infer<typeof BookingPaymentKindSchema>;

/** Stripe's ids Pepper keeps: a customer, a payment or a setup, a refund. */
export const StripeCustomerIdSchema = z.string().regex(/^cus_[A-Za-z0-9]{1,100}$/);
export const StripePaymentIntentIdSchema = z.string().regex(/^pi_[A-Za-z0-9]{1,100}$/);
export const StripeSetupIntentIdSchema = z.string().regex(/^seti_[A-Za-z0-9]{1,100}$/);
export const StripeRefundIdSchema = z.string().regex(/^re_[A-Za-z0-9]{1,100}$/);
export const StripeIntentIdSchema = z.union([
  StripePaymentIntentIdSchema,
  StripeSetupIntentIdSchema,
]);
export type StripeCustomerId = z.infer<typeof StripeCustomerIdSchema>;
export type StripeIntentId = z.infer<typeof StripeIntentIdSchema>;
export type StripeRefundId = z.infer<typeof StripeRefundIdSchema>;

/** What Stripe's hosted field needs to take the card: never stored, never logged. */
export const StripeClientSecretSchema = z
  .string()
  .regex(/^(pi|seti)_[A-Za-z0-9]{1,100}_secret_[A-Za-z0-9]{1,200}$/);

/** `POST /v1/customers`. */
export const StripeCustomerSchema = z.object({
  id: StripeCustomerIdSchema,
  object: z.literal('customer'),
});

/** `/v1/payment_intents`: the parts Pepper checks before booking and after a capture. */
export const StripePaymentIntentSchema = z.object({
  id: StripePaymentIntentIdSchema,
  object: z.literal('payment_intent'),
  amount: z.number().int().min(0),
  amount_received: z.number().int().min(0).optional(),
  currency: z.string().regex(/^[a-z]{3}$/),
  customer: StripeCustomerIdSchema.nullable(),
  status: z.enum([
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'requires_capture',
    'canceled',
    'succeeded',
  ]),
  client_secret: StripeClientSecretSchema.nullable(),
  livemode: z.boolean(),
});
export type StripePaymentIntent = z.infer<typeof StripePaymentIntentSchema>;

/** `/v1/setup_intents`: a card kept for later. */
export const StripeSetupIntentSchema = z.object({
  id: StripeSetupIntentIdSchema,
  object: z.literal('setup_intent'),
  customer: StripeCustomerIdSchema.nullable(),
  status: z.enum([
    'requires_payment_method',
    'requires_confirmation',
    'requires_action',
    'processing',
    'canceled',
    'succeeded',
  ]),
  client_secret: StripeClientSecretSchema.nullable(),
  livemode: z.boolean(),
});
export type StripeSetupIntent = z.infer<typeof StripeSetupIntentSchema>;

/** `/v1/refunds`. */
export const StripeRefundSchema = z.object({
  id: StripeRefundIdSchema,
  object: z.literal('refund'),
  amount: z.number().int().min(0),
  status: z.enum(['pending', 'requires_action', 'succeeded', 'failed', 'canceled']),
});
export type StripeRefund = z.infer<typeof StripeRefundSchema>;

/**
 * `POST /v1/public/businesses/:slug/booking-requests/:id/payment` (AC-X-114): the code the client
 * typed, which proves the address before any payment is made.
 */
export const BookingPaymentStartInputSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();
export type BookingPaymentStartInput = z.infer<typeof BookingPaymentStartInputSchema>;

/** Stripe's publishable key (`pk_…`): public by design, it loads Stripe's field on the page. */
export const StripePublishableKeySchema = z
  .string()
  .regex(/^pk_(test|live)_[A-Za-z0-9]{10,247}$/, 'Use the pk_… key Stripe shows');

/** Its answer: what the hosted field needs, and the terms the page shows beside it. */
export const BookingPaymentStartSchema = z.object({
  clientSecret: StripeClientSecretSchema,
  /** The key Stripe's field loads with; `null` with the sandbox, which has no field (S66.2). */
  publishableKey: StripePublishableKeySchema.nullable(),
  terms: DepositTermsSchema,
  /** The moment a client's cancel stops getting the deposit back, for the requested time. */
  refundEndsAt: z.iso.datetime(),
  /** `sandbox`: the page settles it with the dev route instead of Stripe's field. */
  provider: z.enum(['stripe', 'sandbox']),
});
export type BookingPaymentStart = z.infer<typeof BookingPaymentStartSchema>;

/**
 * A booking's deposit as its client sees it on the manage page (S66.2, AC-X-123): what was paid
 * (or a card only kept), until when a cancel gets it back (the stored window, `null` for a card
 * on file), and where it stands: `held` (paid or kept on file), `kept` (a late cancel),
 * `refunding` (a refund on its way; a failed one is the business's to sort out, and it was told),
 * `refunded`. `refundableNow` is the server's answer for this moment, so the page never decides
 * by the browser's clock alone.
 */
export const PublicBookingDepositSchema = z
  .object({
    kind: BookingPaymentKindSchema,
    amountCents: z.number().int().min(0),
    refundEndsAt: z.iso.datetime().nullable(),
    status: z.enum(['held', 'kept', 'refunding', 'refunded']),
    refundableNow: z.boolean(),
  })
  .strict();
export type PublicBookingDeposit = z.infer<typeof PublicBookingDepositSchema>;

/** `POST /v1/dev/payments/intent` (AC-X-120): settles a sandbox payment as a card would. */
export const SandboxIntentRequestSchema = z
  .object({ clientSecret: StripeClientSecretSchema, outcome: z.enum(['succeeded', 'declined']) })
  .strict();
export type SandboxIntentRequest = z.infer<typeof SandboxIntentRequestSchema>;

/**
 * A `payment` outbox message (ADR-0068 §3–4): capture a booked deposit, or refund (or let go of)
 * a cancelled one. Ids only.
 */
export const OutboxPaymentSchema = z
  .object({ kind: z.enum(['capture', 'refund']), bookingPaymentId: z.uuid() })
  .strict();
export type OutboxPayment = z.infer<typeof OutboxPaymentSchema>;
