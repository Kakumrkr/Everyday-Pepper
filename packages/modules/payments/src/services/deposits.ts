import {
  BookingPaymentStartSchema,
  BookingPaymentStatusSchema,
  depositRefundEndsAt,
  StripeAccountIdSchema,
  StripeCustomerIdSchema,
  UserIdSchema,
  BookingIdSchema,
  type BookingDeposit,
  type BookingPaymentStart,
  type BookingPaymentStatus,
  type DepositTerms,
  type OutboxPayment,
  type PublicBookingDeposit,
  type TenantId,
} from '@pepper/contracts';
import { queuePayment, queuePushToMembers, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  findBooking,
  findBookingPayment,
  findBookingPaymentByBooking,
  findBookingPaymentByRequest,
  findPaymentAccount,
  insertBookingPayment,
  listMemberships,
  listOpenBookingPayments,
  moveBookingPayment,
  touchBookingPayment,
  withMember,
  withTenant,
  type BookingPaymentChange,
  type BookingPaymentRow,
  type TenantTx,
} from '@pepper/db';
import { DepositsUnavailableError, PaymentNotAuthorizedError } from '../errors.js';
import { PaymentsProviderError, type PaymentsProvider } from '../provider.js';
import type { PaymentsDeps } from './accounts.js';

// Booking page deposits and cards on file (S66, ADR-0068). The order is: after the request's code,
// `startBookingPayment` makes one customer and one intent per request (Stripe's keys by request);
// the client's card goes into Stripe's field; `requireAuthorizedPayment` reads the intent from
// Stripe again before booking; the booking's transaction calls `attachBookingPaymentIn`, which
// queues the capture in the outbox; a cancel calls `settleDepositOnCancelIn` in its transaction,
// which keeps the deposit or queues its refund. The worker runs each queued step
// (`runPaymentJob`) and `sweepBookingPayments`. No call to Stripe runs inside a transaction; the
// business always comes from the request's page or the stored row, never from Stripe's answers.

/** What the booking page's request is, once its code was checked (from appointments). */
export interface VerifiedPaymentRequest {
  tenantId: TenantId;
  requestId: string;
  startsAt: Date;
  terms: DepositTerms;
  /** On the client's statement: the business and the service. */
  description: string;
}

/** A payment nobody booked with is let go this long after it was made. */
export const UNUSED_PAYMENT_MS = 60 * 60_000;

function customerKey(requestId: string): string {
  return `pepper-customer-${requestId}`;
}

function intentKey(requestId: string): string {
  return `pepper-deposit-${requestId}`;
}

/** Whether the deployment's provider and mode made this payment (ADR-0067 §4). */
function isOurs(row: BookingPaymentRow, provider: PaymentsProvider): boolean {
  return row.provider === provider.provider && row.livemode === provider.livemode;
}

/**
 * The business's account, when it can take charges in this deployment's provider and mode;
 * `undefined` otherwise (AC-X-113: deposit services can't be booked online then).
 */
export async function chargeableAccountIn(
  tx: TenantTx,
  provider: Pick<PaymentsProvider, 'provider' | 'livemode'>,
): Promise<string | undefined> {
  const row = await findPaymentAccount(tx);
  if (
    row?.deauthorizedAt !== null ||
    row.provider !== provider.provider ||
    row.livemode !== provider.livemode ||
    !row.chargesEnabled
  ) {
    return undefined;
  }
  return row.providerAccountId;
}

/**
 * `POST …/booking-requests/:id/payment` (AC-X-114): the request's payment, made the first time.
 * Asking again (a reload, a second device) answers the same intent's client secret. Answers only
 * what Stripe's field needs and the terms; no card data passes through Pepper.
 */
export async function startBookingPayment(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock'> & {
    /** Stripe's publishable key, for its field on the page; `null` with the sandbox (S66.2). */
    publishableKey?: string | null;
  },
  request: VerifiedPaymentRequest,
): Promise<BookingPaymentStart> {
  const key = deps.publishableKey ?? null;
  const { tenantId, requestId, terms } = request;
  const existing = await withTenant(deps.db, tenantId, (tx) =>
    findBookingPaymentByRequest(tx, requestId),
  );
  if (existing !== undefined) return answer(deps.provider, key, existing, request);

  const accountId = await withTenant(deps.db, tenantId, (tx) =>
    chargeableAccountIn(tx, deps.provider),
  );
  if (accountId === undefined) throw new DepositsUnavailableError();
  const account = StripeAccountIdSchema.parse(accountId);
  const customer = await deps.provider.createCustomer({
    tenantId,
    idempotencyKey: customerKey(requestId),
  });
  const customerId = StripeCustomerIdSchema.parse(customer.id);
  const intent =
    terms.kind === 'deposit'
      ? await deps.provider.createDeposit({
          tenantId,
          requestId,
          accountId: account,
          customerId,
          amountCents: terms.amountCents,
          description: request.description,
          idempotencyKey: intentKey(requestId),
        })
      : await deps.provider.createCardSetup({
          tenantId,
          requestId,
          accountId: account,
          customerId,
          idempotencyKey: intentKey(requestId),
        });
  const stored = await withTenant(deps.db, tenantId, async (tx) => {
    const row = await insertBookingPayment(tx, {
      requestId,
      provider: deps.provider.provider,
      livemode: deps.provider.livemode,
      kind: terms.kind,
      intentId: intent.id,
      customerId,
      accountId: account,
      amountCents: terms.kind === 'deposit' ? terms.amountCents : 0,
      refundHours: terms.refundHours,
    });
    // Another tap stored it first: the same intent (the same key), so answer that row.
    if (row === undefined) return findBookingPaymentByRequest(tx, requestId);
    await audit(tx, row, null);
    return row;
  });
  if (stored === undefined) throw new Error('booking payment vanished while starting');
  return answer(deps.provider, key, stored, request);
}

async function answer(
  provider: PaymentsProvider,
  publishableKey: string | null,
  row: BookingPaymentRow,
  request: VerifiedPaymentRequest,
): Promise<BookingPaymentStart> {
  // Only a payment still waiting for its card can be paid; any other is done with.
  if (row.status !== 'started' || !isOurs(row, provider)) throw new DepositsUnavailableError();
  const intent =
    row.kind === 'deposit'
      ? await provider.retrievePaymentIntent(row.intentId)
      : await provider.retrieveSetupIntent(row.intentId);
  if (intent.client_secret === null || intent.status === 'canceled') {
    throw new DepositsUnavailableError();
  }
  // The terms as stored with the payment: what the client is agreeing to pay.
  const terms: DepositTerms =
    row.kind === 'deposit'
      ? { kind: 'deposit', amountCents: row.amountCents, refundHours: row.refundHours }
      : { kind: 'card', refundHours: row.refundHours };
  return BookingPaymentStartSchema.parse({
    clientSecret: intent.client_secret,
    publishableKey: provider.provider === 'stripe' ? publishableKey : null,
    terms,
    refundEndsAt: depositRefundEndsAt(request.startsAt, row.refundHours).toISOString(),
    provider: provider.provider,
  });
}

/**
 * Before booking (AC-X-115): reads the request's payment from Stripe again and answers when it is
 * authorized for the stored amount, currency and customer (a card setup: succeeded with the
 * stored customer). Otherwise `PaymentNotAuthorizedError`: nothing is booked.
 */
export async function requireAuthorizedPayment(
  deps: Pick<PaymentsDeps, 'db' | 'provider'>,
  tenantId: TenantId,
  requestId: string,
): Promise<void> {
  const row = await withTenant(deps.db, tenantId, (tx) =>
    findBookingPaymentByRequest(tx, requestId),
  );
  if (row?.status !== 'started' || !isOurs(row, deps.provider)) {
    throw new PaymentNotAuthorizedError();
  }
  if (row.kind === 'deposit') {
    const intent = await deps.provider.retrievePaymentIntent(row.intentId);
    const authorized = intent.status === 'requires_capture' || intent.status === 'succeeded';
    if (
      !authorized ||
      intent.amount !== row.amountCents ||
      intent.currency !== row.currency ||
      intent.customer !== row.customerId
    ) {
      throw new PaymentNotAuthorizedError();
    }
    return;
  }
  const setup = await deps.provider.retrieveSetupIntent(row.intentId);
  if (setup.status !== 'succeeded' || setup.customer !== row.customerId) {
    throw new PaymentNotAuthorizedError();
  }
}

/**
 * In the booking's transaction (AC-X-115): ties the request's payment to the new booking and
 * queues the deposit's capture, so both commit with the booking or not at all. `false` when the
 * request has no payment waiting (the caller books nothing then).
 */
export async function attachBookingPaymentIn(
  tx: TenantTx,
  input: { requestId: string; bookingId: string; startsAt: Date; now: Date; outboxKey: Buffer },
): Promise<boolean> {
  const row = await findBookingPaymentByRequest(tx, input.requestId, { lock: true });
  if (row?.status !== 'started') return false;
  const moved = await move(tx, row, ['started'], {
    status: row.kind === 'deposit' ? 'booked' : 'card_saved',
    bookingId: input.bookingId,
    bookedAt: input.now,
    refundEndsAt: depositRefundEndsAt(input.startsAt, row.refundHours),
  });
  if (moved === undefined) return false;
  if (moved.kind === 'deposit') {
    await queueStep(tx, { kind: 'capture', bookingPaymentId: moved.id }, input);
  }
  return true;
}

/** Who cancelled: the client from their link, or the business (a member, or Pepper on an OK). */
export type CancelledBy = 'client' | 'business';

/** What the client is told about each stored status (S66.2, AC-X-123); absent: nothing to say. */
const CLIENT_STATUS: Partial<Record<BookingPaymentStatus, PublicBookingDeposit['status']>> = {
  booked: 'held',
  captured: 'held',
  card_saved: 'held',
  kept: 'kept',
  refund_pending: 'refunding',
  // A refund Stripe refused for good is the business's to sort out (its owners were told); the
  // client isn't told their deposit is kept when it was meant to come back.
  refund_failed: 'refunding',
  refunded: 'refunded',
};

/** What the team is told about each stored status (S67, AC-X-129): a failed refund is said. */
const TEAM_STATUS: Partial<Record<BookingPaymentStatus, BookingDeposit['status']>> = {
  ...CLIENT_STATUS,
  refund_failed: 'refund_failed',
};

/** A payment row as a view at `now`, with the stored window (S66.2/S67). */
function depositViewOf<S extends string>(
  row: BookingPaymentRow,
  statuses: Partial<Record<BookingPaymentStatus, S>>,
  input: { startsAt: Date; now: Date },
): {
  kind: 'deposit' | 'card';
  amountCents: number;
  refundEndsAt: string | null;
  status: S;
  refundableNow: boolean;
} | null {
  const status = statuses[BookingPaymentStatusSchema.parse(row.status)];
  if (status === undefined) return null;
  if (row.kind === 'card') {
    return { kind: 'card', amountCents: 0, refundEndsAt: null, status, refundableNow: false };
  }
  const endsAt = row.refundEndsAt ?? depositRefundEndsAt(input.startsAt, row.refundHours);
  return {
    kind: 'deposit',
    amountCents: row.amountCents,
    refundEndsAt: endsAt.toISOString(),
    status,
    refundableNow: status === 'held' && input.now.getTime() <= endsAt.getTime(),
  };
}

/**
 * A booking's deposit for its client's manage page (S66.2, AC-X-123), in the booking's read:
 * the stored window decides `refundableNow`, never the page. `null` with no payment, or one that
 * never took anything (let go, or its capture refused).
 */
export async function bookingDepositIn(
  tx: TenantTx,
  input: { bookingId: string; startsAt: Date; now: Date },
): Promise<PublicBookingDeposit | null> {
  const row = await findBookingPaymentByBooking(tx, input.bookingId);
  return row === undefined ? null : depositViewOf(row, CLIENT_STATUS, input);
}

/**
 * A booking's deposit for the team's booking sheet (S67 top-up, AC-X-129): owners and managers
 * (`payments.read`); a refund Stripe refused is said as such. `null`: no such booking in the
 * business, or no payment that took something.
 */
export async function readBookingDeposit(
  deps: Pick<PaymentsDeps, 'db' | 'clock'>,
  actor: Actor,
  bookingId: string,
): Promise<BookingDeposit | null> {
  requirePermission(actor, 'payments.read');
  const id = BookingIdSchema.parse(bookingId);
  return withMember(deps.db, actor.context, async (tx) => {
    const booking = await findBooking(tx, id);
    if (booking === undefined) return null;
    const row = await findBookingPaymentByBooking(tx, booking.id);
    if (row === undefined) return null;
    return depositViewOf(row, TEAM_STATUS, { startsAt: booking.startsAt, now: deps.clock.now() });
  });
}

/**
 * In a move's transaction (AC-X-117): the refund's end follows the booking's new time when the
 * business moved it, or when the client moved it while a cancel would still have been refunded.
 * Once it has passed, a client's move keeps it, so a reschedule can't win back a kept deposit.
 */
export async function moveDepositWindowIn(
  tx: TenantTx,
  input: { bookingId: string; startsAt: Date; by: CancelledBy; now: Date },
): Promise<void> {
  const row = await findBookingPaymentByBooking(tx, input.bookingId, { lock: true });
  if (row?.kind !== 'deposit' || (row.status !== 'booked' && row.status !== 'captured')) return;
  const open = row.refundEndsAt === null || input.now.getTime() <= row.refundEndsAt.getTime();
  if (input.by === 'client' && !open) return;
  const status = BookingPaymentStatusSchema.parse(row.status);
  await moveBookingPayment(tx, row.id, [status], {
    status,
    refundEndsAt: depositRefundEndsAt(input.startsAt, row.refundHours),
  });
}

/**
 * In the cancel's transaction (AC-X-117/118): a paid deposit is refunded in full when the business
 * cancels, or when the client cancels at least the agreed window before the booking's current
 * start; a later client cancel keeps it. A card on file with nothing paid needs nothing. Asking
 * twice changes nothing more.
 */
export async function settleDepositOnCancelIn(
  tx: TenantTx,
  input: { bookingId: string; startsAt: Date; by: CancelledBy; now: Date; outboxKey: Buffer },
): Promise<BookingPaymentStatus | null> {
  const row = await findBookingPaymentByBooking(tx, input.bookingId, { lock: true });
  if (row?.kind !== 'deposit' || (row.status !== 'booked' && row.status !== 'captured')) {
    return null;
  }
  const endsAt = row.refundEndsAt ?? depositRefundEndsAt(input.startsAt, row.refundHours);
  const refund = input.by === 'business' || input.now.getTime() <= endsAt.getTime();
  if (!refund) {
    await move(tx, row, ['booked', 'captured'], { status: 'kept', settledAt: input.now });
    return 'kept';
  }
  const moved = await move(tx, row, ['booked', 'captured'], { status: 'refund_pending' });
  if (moved !== undefined) {
    await queueStep(tx, { kind: 'refund', bookingPaymentId: moved.id }, input);
  }
  return 'refund_pending';
}

async function queueStep(
  tx: TenantTx,
  job: OutboxPayment,
  options: { now: Date; outboxKey: Buffer },
): Promise<void> {
  await queuePayment(tx, job, {
    key: options.outboxKey,
    dedupeKey: `payment.${job.kind}:${job.bookingPaymentId}`,
    now: options.now,
  });
}

/**
 * Runs one queued step (the worker's `PaymentRunner`, AC-X-119). Throws to be retried when
 * Stripe fails for a passing reason; anything else is recorded on the payment.
 */
export async function runPaymentJob(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>,
  tenantId: TenantId,
  job: OutboxPayment,
): Promise<void> {
  const row = await withTenant(deps.db, tenantId, (tx) =>
    findBookingPayment(tx, job.bookingPaymentId),
  );
  if (row?.kind !== 'deposit' || !isOurs(row, deps.provider)) return;
  if (job.kind === 'capture') await capture(deps, tenantId, row);
  else await refund(deps, tenantId, row);
}

/** Takes a booked deposit (or one kept by a quick late cancel), once (its key). */
async function capture(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>,
  tenantId: TenantId,
  row: BookingPaymentRow,
): Promise<void> {
  if (row.capturedAt !== null || (row.status !== 'booked' && row.status !== 'kept')) return;
  let succeeded: boolean;
  try {
    succeeded =
      (await deps.provider.capturePaymentIntent(row.intentId, `pepper-capture-${row.id}`))
        .status === 'succeeded';
  } catch (error) {
    if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
    // Refused for good: what does Stripe say it is now?
    succeeded = (await deps.provider.retrievePaymentIntent(row.intentId)).status === 'succeeded';
  }
  const now = deps.clock.now();
  await withTenant(deps.db, tenantId, async (tx) => {
    const status: BookingPaymentStatus = row.status === 'kept' ? 'kept' : 'captured';
    const moved = await move(
      tx,
      row,
      [BookingPaymentStatusSchema.parse(row.status)],
      succeeded ? { status, capturedAt: now } : { status: 'capture_failed', settledAt: now },
    );
    if (!succeeded && moved !== undefined) {
      await tellOwners(tx, moved, 'capture_failed', { outboxKey: deps.outboxKey, now });
    }
  });
}

/**
 * Gives a cancelled deposit back (AC-X-119): an authorization not yet captured is let go (nothing
 * was taken); a captured one is refunded in full with the transfer reversed, once (its key).
 */
async function refund(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>,
  tenantId: TenantId,
  row: BookingPaymentRow,
): Promise<void> {
  if (row.status !== 'refund_pending' || row.refundId !== null) return;
  const intent = await deps.provider.retrievePaymentIntent(row.intentId);
  const now = deps.clock.now();
  if (intent.status !== 'succeeded' && (await letGo(deps.provider, row))) {
    await withTenant(deps.db, tenantId, (tx) =>
      move(tx, row, ['refund_pending'], { status: 'refunded', settledAt: now }),
    );
    return;
  }
  let answered: { id: string | null; status: string };
  try {
    answered = await deps.provider.createRefund(row.intentId, `pepper-refund-${row.id}`);
  } catch (error) {
    // Refused for good (refunded in Stripe's dashboard, disputed): recorded and told, not retried.
    if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
    answered = { id: null, status: 'failed' };
  }
  await withTenant(deps.db, tenantId, (tx) => applyRefund(tx, row, answered, now, deps));
}

/**
 * Lets an authorization go; `false` when Stripe captured it meanwhile (the capture won the race),
 * so it is refunded instead.
 */
async function letGo(provider: PaymentsProvider, row: BookingPaymentRow): Promise<boolean> {
  try {
    const canceled = await provider.cancelPaymentIntent(row.intentId, `pepper-void-${row.id}`);
    return canceled.status === 'canceled';
  } catch (error) {
    if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
    const now = await provider.retrievePaymentIntent(row.intentId);
    if (now.status === 'canceled') return true;
    if (now.status === 'succeeded') return false;
    throw error;
  }
}

async function applyRefund(
  tx: TenantTx,
  row: BookingPaymentRow,
  answered: { id: string | null; status: string },
  now: Date,
  deps: Pick<PaymentsDeps, 'outboxKey'>,
): Promise<void> {
  const refundId = answered.id === null ? {} : { refundId: answered.id };
  if (answered.status === 'succeeded') {
    await move(tx, row, ['refund_pending'], { status: 'refunded', ...refundId, settledAt: now });
  } else if (answered.status === 'failed' || answered.status === 'canceled') {
    const failed = await move(tx, row, ['refund_pending'], {
      status: 'refund_failed',
      ...refundId,
      settledAt: now,
    });
    if (failed !== undefined) {
      await tellOwners(tx, failed, 'refund_failed', { outboxKey: deps.outboxKey, now });
    }
  } else {
    // Pending at Stripe: the sweep reads it again.
    await move(tx, row, ['refund_pending'], { status: 'refund_pending', ...refundId });
  }
}

/**
 * A deposit that couldn't be given back or taken: every owner hears, once per payment, opening
 * More → Payments (Stripe's dashboard). No client's name on the lock screen.
 */
async function tellOwners(
  tx: TenantTx,
  row: BookingPaymentRow,
  outcome: 'refund_failed' | 'capture_failed',
  options: { outboxKey: Buffer; now: Date },
): Promise<void> {
  const owners = (await listMemberships(tx))
    .filter((membership) => membership.role === 'owner')
    .map((membership) => UserIdSchema.parse(membership.userId));
  const amount = '$' + (row.amountCents / 100).toFixed(2);
  const notice =
    outcome === 'refund_failed'
      ? {
          title: 'A deposit couldn’t be refunded',
          body:
            'Stripe refused to give back a ' +
            amount +
            ' deposit. Refund it from your Stripe dashboard.',
          url: '/more/payments',
        }
      : {
          title: 'A deposit couldn’t be taken',
          body:
            'Stripe refused a ' + amount + ' deposit for a booking. The booking stands without it.',
          url: '/more/payments',
        };
  await queuePushToMembers(tx, owners, notice, {
    key: options.outboxKey,
    dedupeKey: 'payment.' + outcome + ':' + row.id,
    now: options.now,
  });
}

/**
 * The worker's sweep (AC-X-116): lets go of payments nobody booked with an hour after they were
 * made, and reads refunds Stripe left pending again. Each step marks the row first (a booking
 * then can't take a payment being let go), then asks Stripe. Answers how many it looked at.
 */
export async function sweepBookingPayments(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>,
  options: { limit?: number; ageMs?: number } = {},
): Promise<number> {
  const now = deps.clock.now();
  const open = await listOpenBookingPayments(
    deps.db,
    options.ageMs ?? UNUSED_PAYMENT_MS,
    options.limit ?? 100,
  );
  for (const { tenantId, id } of open) {
    try {
      await sweepOne(deps, tenantId, id, now);
    } catch (error) {
      // One payment's trouble doesn't stop the others; it is looked at again next time.
      if (!(error instanceof PaymentsProviderError)) throw error;
      await withTenant(deps.db, tenantId, (tx) => touchBookingPayment(tx, id));
    }
  }
  return open.length;
}

async function sweepOne(
  deps: Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>,
  tenantId: TenantId,
  id: string,
  now: Date,
): Promise<void> {
  const row = await withTenant(deps.db, tenantId, (tx) => findBookingPayment(tx, id));
  if (row === undefined) return;
  if (!isOurs(row, deps.provider)) {
    // Made by another deployment's provider (the sandbox before Stripe): nothing to ask, so
    // each such row is closed and leaves the sweep's list.
    await withTenant(deps.db, tenantId, async (tx) => {
      await move(tx, row, ['started', 'voided'], { status: 'voided', settledAt: now });
      await move(tx, row, ['refund_pending'], { status: 'refund_failed', settledAt: now });
    });
    return;
  }
  if (row.status === 'started' || (row.status === 'voided' && row.settledAt === null)) {
    // Marked first, so a booking can no longer take it; settled once Stripe let it go, and
    // looked at again by a later sweep until then (AC-X-116).
    const voided = await withTenant(deps.db, tenantId, (tx) =>
      move(tx, row, ['started', 'voided'], { status: 'voided' }),
    );
    if (voided === undefined) return;
    if (row.kind === 'deposit') {
      const intent = await deps.provider.retrievePaymentIntent(row.intentId);
      if (intent.status !== 'canceled' && intent.status !== 'succeeded') {
        await deps.provider.cancelPaymentIntent(row.intentId, `pepper-void-${row.id}`);
      }
    }
    await withTenant(deps.db, tenantId, (tx) =>
      move(tx, row, ['voided'], { status: 'voided', settledAt: now }),
    );
    return;
  }
  if (row.status === 'refund_pending' && row.refundId !== null) {
    const answered = await deps.provider.retrieveRefund(row.refundId);
    await withTenant(deps.db, tenantId, async (tx) => {
      await applyRefund(tx, row, answered, now, deps);
      // Still pending: looked at again after the others.
      await touchBookingPayment(tx, row.id);
    });
  }
}

/** Moves a payment and audits the move (statuses and the amount only), in one transaction. */
async function move(
  tx: TenantTx,
  row: BookingPaymentRow,
  from: readonly BookingPaymentStatus[],
  change: BookingPaymentChange,
): Promise<BookingPaymentRow | undefined> {
  const moved = await moveBookingPayment(tx, row.id, from, change);
  if (moved !== undefined && moved.status !== row.status) {
    await audit(tx, moved, BookingPaymentStatusSchema.parse(row.status));
  }
  return moved;
}

async function audit(
  tx: TenantTx,
  row: BookingPaymentRow,
  before: BookingPaymentStatus | null,
): Promise<void> {
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'payments.deposit_changed',
      entity: { type: 'booking_payment', id: row.id },
      before: before === null ? null : { status: before },
      after: {
        status: BookingPaymentStatusSchema.parse(row.status),
        amountCents: row.amountCents,
        bookingId: row.bookingId,
      },
    },
  });
}
