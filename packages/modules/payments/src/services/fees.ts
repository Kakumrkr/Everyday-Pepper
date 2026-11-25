import {
  BookingFeeStatusSchema,
  BookingIdSchema,
  BookingPaymentStatusSchema,
  CancellationFeesSchema,
  ClientIdSchema,
  PaymentProviderSchema,
  ServiceIdSchema,
  cancellationSentence,
  moneyWords,
  NO_SHOW_FEE_GRACE_SECONDS,
  noShowFeeCents,
  noShowFeeToCharge,
  shortDateTimeWords,
  StripeAccountIdSchema,
  StripeCustomerIdSchema,
  UserIdSchema,
  type BookingFeeStatus,
  type BookingPaymentStatus,
  type TenantId,
} from '@pepper/contracts';
import {
  auditActorOf,
  queueEmail,
  queuePayment,
  queuePushToMembers,
  requirePermission,
  type Actor,
} from '@pepper/core';
import {
  appendAuditEntry,
  findBooking,
  findBookingFee,
  findBookingFeeByBooking,
  findBookingPayment,
  findBookingPaymentByBooking,
  findClient,
  findCurrentTenant,
  findPaymentAccount,
  findService,
  insertBookingFee,
  listMemberships,
  moveBookingFee,
  withTenant,
  type BookingFeeChange,
  type BookingFeeRow,
  type TenantTx,
} from '@pepper/db';
import { NoShowFeeBusyError, NoShowFeeNotChargeableError } from '../errors.js';
import { PaymentsProviderError } from '../provider.js';
import type { PaymentsDeps } from './accounts.js';

// No-show fees by approval (S68, ADR-0068 amendment). The terms the client was shown are stored
// with the booking's payment when it is booked (`termsAtBookingIn`, AC-X-136). A no-show then
// lets Pepper propose one card (`noShowFeeOfferIn`, AC-X-137); nothing here charges until the
// owner approves it (`approveNoShowFeeIn`, AC-X-139), which records the fee and queues one charge
// after a grace; the worker charges the kept card off-session (`runFeeJob`, AC-X-140) and the
// client gets a receipt (AC-X-142). Undo cancels a fee that waits, and refunds one taken
// (`undoNoShowFeeIn`, AC-X-141). No call to Stripe runs inside a transaction.

/** A payment that still holds a card Stripe kept for the business (ADR-0068 §3). */
const CARD_KEPT: ReadonlySet<BookingPaymentStatus> = new Set([
  'booked',
  'captured',
  'card_saved',
  'kept',
]);

/** Why a fee can't be charged: the card's refusal on approval, and why no card is proposed. */
export type NoShowFeeRefusal =
  'not_no_show' | 'no_terms' | 'no_card' | 'nothing_to_charge' | 'payments_off' | 'already_decided';

/** What a card offers: the fee the stored terms allow, a kept deposit, and what is left. */
export interface NoShowFeeOffer {
  bookingId: string;
  bookingPaymentId: string;
  clientId: string;
  feeCents: number;
  keptDepositCents: number;
  chargeCents: number;
  /** The policy's sentence as the client saw it, and when they agreed (the booking). */
  policySentence: string;
  agreedAt: Date;
  /** `deposit`: the deposit's card; `card`: a card kept with nothing paid. */
  cardKind: 'deposit' | 'card';
}

/**
 * In the booking's transaction (AC-X-136): the terms the client was shown, kept with the
 * payment: the policy's sentence for the agreed window and the no-show fee in cents (a percent
 * of the booked starting price). `null`s with no policy.
 */
export async function termsAtBookingIn(
  tx: TenantTx,
  input: { bookingId: string; refundHours: number },
): Promise<{ policySentence: string | null; noShowFeeCents: number | null }> {
  const tenant = await findCurrentTenant(tx);
  const booking = await findBooking(tx, BookingIdSchema.parse(input.bookingId));
  const fees = CancellationFeesSchema.nullable().catch(null).parse(tenant?.cancellationFees);
  const policySentence = cancellationSentence(fees, input.refundHours);
  if (fees === null || policySentence === null)
    return { policySentence: null, noShowFeeCents: null };
  const fee = noShowFeeCents(fees.noShow, booking?.priceFromCents ?? null);
  return { policySentence, noShowFeeCents: fee };
}

/** Whether the deployment's provider and mode made this payment (ADR-0067 §4). */
function isOurs(
  row: { provider: string; livemode: boolean },
  provider: { provider: string; livemode: boolean },
): boolean {
  return row.provider === provider.provider && row.livemode === provider.livemode;
}

/**
 * The fee a no-show may be charged, or why not (AC-X-137): the visit is a no-show, its payment
 * still holds the card and stored a no-show fee, the business can take charges with the same
 * provider and mode, no fee was decided for it yet, and something is left after a kept deposit.
 */
export async function noShowFeeOfferIn(
  tx: TenantTx,
  bookingId: string,
): Promise<NoShowFeeOffer | NoShowFeeRefusal> {
  const booking = await findBooking(tx, BookingIdSchema.parse(bookingId));
  if (booking?.status !== 'no_show') return 'not_no_show';
  const payment = await findBookingPaymentByBooking(tx, booking.id);
  if (payment === undefined) return 'no_card';
  if (!CARD_KEPT.has(BookingPaymentStatusSchema.parse(payment.status))) return 'no_card';
  if (payment.noShowFeeCents === null || payment.policySentence === null) return 'no_terms';
  const account = await findPaymentAccount(tx);
  if (
    account?.deauthorizedAt !== null ||
    !account.chargesEnabled ||
    account.providerAccountId !== payment.accountId ||
    !isOurs({ provider: account.provider, livemode: account.livemode }, payment)
  ) {
    return 'payments_off';
  }
  if ((await findBookingFeeByBooking(tx, booking.id)) !== undefined) return 'already_decided';
  const keptDepositCents = payment.kind === 'deposit' ? payment.amountCents : 0;
  const chargeCents = noShowFeeToCharge(payment.noShowFeeCents, keptDepositCents);
  if (chargeCents === null) return 'nothing_to_charge';
  return {
    bookingId: booking.id,
    bookingPaymentId: payment.id,
    clientId: booking.clientId,
    feeCents: payment.noShowFeeCents,
    keptDepositCents,
    chargeCents,
    policySentence: payment.policySentence,
    agreedAt: payment.bookedAt ?? booking.createdAt,
    cardKind: payment.kind === 'deposit' ? 'deposit' : 'card',
  };
}

/**
 * The owner's OK (AC-X-139), in the approval's transaction: owners only (`payments.manage`); the
 * offer is read again, and its amount must be the one the card showed (`chargeCents`). Records the
 * fee and queues its charge after the grace, so an Undo right after moves no money.
 */
export async function approveNoShowFeeIn(
  tx: TenantTx,
  actor: Actor,
  input: { bookingId: string; chargeCents: number; now: Date; outboxKey: Buffer },
): Promise<BookingFeeRow> {
  requirePermission(actor, 'payments.manage');
  const offer = await noShowFeeOfferIn(tx, input.bookingId);
  if (typeof offer === 'string') throw new NoShowFeeNotChargeableError(offer);
  if (offer.chargeCents !== input.chargeCents) {
    throw new NoShowFeeNotChargeableError('nothing_to_charge');
  }
  const payment = await findBookingPayment(tx, offer.bookingPaymentId);
  if (payment === undefined) throw new NoShowFeeNotChargeableError('no_card');
  const row = await insertBookingFee(tx, {
    bookingId: offer.bookingId,
    bookingPaymentId: offer.bookingPaymentId,
    provider: PaymentProviderSchema.parse(payment.provider),
    livemode: payment.livemode,
    amountCents: offer.chargeCents,
    policySentence: offer.policySentence,
    agreedAt: offer.agreedAt,
    approvedBy: UserIdSchema.parse(actor.context.userId),
    approvedAt: input.now,
  });
  if (row === undefined) throw new NoShowFeeNotChargeableError('already_decided');
  await audit(tx, row, null, auditActorOf(actor));
  await queuePayment(
    tx,
    { kind: 'fee_charge', bookingFeeId: row.id },
    {
      key: input.outboxKey,
      dedupeKey: `payment.fee_charge:${row.id}`,
      now: new Date(input.now.getTime() + NO_SHOW_FEE_GRACE_SECONDS * 1000),
    },
  );
  return row;
}

/**
 * The trust layer's Undo (AC-X-141), in its transaction: a fee still waiting is cancelled (no
 * money moves); one taken is refunded in full through the outbox. One being charged this moment
 * can't be decided yet (`NoShowFeeBusyError`: try again). Asking twice changes nothing more.
 */
export async function undoNoShowFeeIn(
  tx: TenantTx,
  actor: Actor,
  input: { bookingFeeId: string; now: Date; outboxKey: Buffer },
): Promise<BookingFeeStatus> {
  requirePermission(actor, 'payments.manage');
  const row = await findBookingFee(tx, input.bookingFeeId, { lock: true });
  if (row === undefined) throw new NoShowFeeNotChargeableError('no_card');
  const status = BookingFeeStatusSchema.parse(row.status);
  if (status === 'queued') {
    await move(tx, row, ['queued'], { status: 'cancelled', settledAt: input.now });
    return 'cancelled';
  }
  if (status === 'charging') throw new NoShowFeeBusyError();
  if (status === 'charged') {
    const moved = await move(tx, row, ['charged'], { status: 'refund_pending' });
    if (moved !== undefined) {
      await queuePayment(
        tx,
        { kind: 'fee_refund', bookingFeeId: row.id },
        { key: input.outboxKey, dedupeKey: `payment.fee_refund:${row.id}`, now: input.now },
      );
    }
    return 'refund_pending';
  }
  return status;
}

type JobDeps = Pick<PaymentsDeps, 'db' | 'provider' | 'clock' | 'outboxKey'>;

/**
 * Runs one queued fee step (the worker's `PaymentRunner`, AC-X-140/141). Throws to be retried
 * when Stripe fails for a passing reason; a decline is recorded and told, never retried.
 */
export async function runFeeJob(
  deps: JobDeps,
  tenantId: TenantId,
  job: { kind: 'fee_charge' | 'fee_refund'; bookingFeeId: string },
): Promise<void> {
  const row = await withTenant(deps.db, tenantId, (tx) => findBookingFee(tx, job.bookingFeeId));
  if (row === undefined || !isOurs(row, deps.provider)) return;
  if (job.kind === 'fee_charge') await charge(deps, tenantId, row);
  else await refund(deps, tenantId, row);
}

/** A decline code as stored: Stripe's own when it reads as one, else `declined`. */
function failureCodeOf(code: string | null): string {
  return code !== null && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'declined';
}

async function charge(deps: JobDeps, tenantId: TenantId, queued: BookingFeeRow): Promise<void> {
  // Marked first, so an Undo now can't cancel what Stripe is being asked to take. A step that
  // stopped half way (`charging`) goes on: Stripe's key answers the first charge again.
  const row = await withTenant(deps.db, tenantId, (tx) =>
    move(tx, queued, ['queued', 'charging'], { status: 'charging' }),
  );
  if (row === undefined) return;
  const payment = await withTenant(deps.db, tenantId, (tx) =>
    findBookingPayment(tx, row.bookingPaymentId),
  );
  if (payment === undefined) return;
  const intent =
    payment.kind === 'deposit'
      ? await deps.provider.retrievePaymentIntent(payment.intentId)
      : await deps.provider.retrieveSetupIntent(payment.intentId);
  const paymentMethod = intent.payment_method ?? null;
  let outcome: { status: 'charged'; intentId: string } | { status: 'failed'; code: string };
  if (paymentMethod === null) {
    outcome = { status: 'failed', code: 'no_card' };
  } else {
    const tenant = await withTenant(deps.db, tenantId, (tx) => findCurrentTenant(tx));
    try {
      const charged = await deps.provider.createOffSessionCharge({
        tenantId,
        bookingFeeId: row.id,
        accountId: StripeAccountIdSchema.parse(payment.accountId),
        customerId: StripeCustomerIdSchema.parse(payment.customerId),
        paymentMethodId: paymentMethod,
        amountCents: row.amountCents,
        description: `${tenant?.name ?? 'Your visit'} · missed visit fee`,
        idempotencyKey: `pepper-fee-${row.id}`,
      });
      outcome =
        charged.status === 'succeeded'
          ? { status: 'charged', intentId: charged.id }
          : {
              status: 'failed',
              code: charged.status === 'requires_action' ? 'authentication_required' : 'declined',
            };
    } catch (error) {
      if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
      outcome = { status: 'failed', code: failureCodeOf(error.code) };
    }
  }
  const now = deps.clock.now();
  await withTenant(deps.db, tenantId, async (tx) => {
    if (outcome.status === 'charged') {
      const done = await move(tx, row, ['charging'], {
        status: 'charged',
        intentId: outcome.intentId,
        chargedAt: now,
        settledAt: now,
      });
      if (done !== undefined) await sendReceipt(tx, done, { outboxKey: deps.outboxKey, now });
      return;
    }
    const failed = await move(tx, row, ['charging'], {
      status: 'failed',
      failureCode: outcome.code,
      settledAt: now,
    });
    if (failed !== undefined) {
      await tellOwners(tx, failed, 'declined', { outboxKey: deps.outboxKey, now });
    }
  });
}

async function refund(deps: JobDeps, tenantId: TenantId, row: BookingFeeRow): Promise<void> {
  if (row.status !== 'refund_pending' || row.refundId !== null || row.intentId === null) return;
  let answered: { id: string | null; status: string };
  try {
    answered = await deps.provider.createRefund(row.intentId, `pepper-fee-refund-${row.id}`);
  } catch (error) {
    // Refused for good (refunded in Stripe's dashboard, disputed): recorded and told.
    if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
    answered = { id: null, status: 'failed' };
  }
  const now = deps.clock.now();
  const refundId = answered.id === null ? {} : { refundId: answered.id };
  await withTenant(deps.db, tenantId, async (tx) => {
    if (answered.status === 'failed' || answered.status === 'canceled') {
      const failed = await move(tx, row, ['refund_pending'], {
        status: 'refund_failed',
        ...refundId,
        settledAt: now,
      });
      if (failed !== undefined) {
        await tellOwners(tx, failed, 'refund_failed', { outboxKey: deps.outboxKey, now });
      }
      return;
    }
    // Card refunds settle at once; one Stripe leaves pending stays `refund_pending` with its id.
    await move(tx, row, ['refund_pending'], {
      status: answered.status === 'succeeded' ? 'refunded' : 'refund_pending',
      ...refundId,
      ...(answered.status === 'succeeded' && { settledAt: now }),
    });
  });
}

/**
 * The client's receipt (AC-X-142): the business, the amount, the missed visit and the policy's
 * sentence as they saw it when booking. Plain text, no card details (Stripe keeps them). A client
 * deleted meanwhile, or with no address, gets none.
 */
async function sendReceipt(
  tx: TenantTx,
  fee: BookingFeeRow,
  options: { outboxKey: Buffer; now: Date },
): Promise<void> {
  const tenant = await findCurrentTenant(tx);
  const booking = await findBooking(tx, BookingIdSchema.parse(fee.bookingId));
  if (tenant === undefined || booking === undefined) return;
  const client = await findClient(tx, ClientIdSchema.parse(booking.clientId));
  if (client?.deletedAt !== null || client.email === null) return;
  const service = await findService(tx, ServiceIdSchema.parse(booking.serviceId));
  const amount = moneyWords(fee.amountCents);
  const visit = shortDateTimeWords(tenant.timeZone, booking.startsAt.toISOString());
  const text = [
    `${tenant.name} charged ${amount} to the card you kept with your booking, for the ${
      service?.name.toLowerCase() ?? 'visit'
    } on ${visit} that was missed.`,
    '',
    'The cancellation policy you were shown when you booked:',
    fee.policySentence,
    '',
    `Amount: ${amount}`,
    `Charged: ${shortDateTimeWords(tenant.timeZone, (fee.chargedAt ?? options.now).toISOString())}`,
    '',
    `If you think this is a mistake, reply to this email or contact ${tenant.name}.`,
  ].join('\n');
  await queueEmail(
    tx,
    { to: client.email, subject: `Receipt: ${amount} missed visit fee from ${tenant.name}`, text },
    { key: options.outboxKey, dedupeKey: `payment.fee_receipt:${fee.id}`, now: options.now },
  );
}

/** A fee declined or not given back: every owner hears, once per fee. No client's name. */
async function tellOwners(
  tx: TenantTx,
  row: BookingFeeRow,
  outcome: 'declined' | 'refund_failed',
  options: { outboxKey: Buffer; now: Date },
): Promise<void> {
  const owners = (await listMemberships(tx))
    .filter((membership) => membership.role === 'owner')
    .map((membership) => UserIdSchema.parse(membership.userId));
  const amount = moneyWords(row.amountCents);
  const notice =
    outcome === 'declined'
      ? {
          title: 'A no-show fee was declined',
          body: `The card on file didn’t take the ${amount} fee. Nothing was charged.`,
          url: '/',
        }
      : {
          title: 'A no-show fee couldn’t be refunded',
          body: `Stripe refused to give back a ${amount} fee. Refund it from your Stripe dashboard.`,
          url: '/more/payments',
        };
  await queuePushToMembers(tx, owners, notice, {
    key: options.outboxKey,
    dedupeKey: `payment.fee_${outcome}:${row.id}`,
    now: options.now,
  });
}

/** Moves a fee and audits the move (statuses, the amount and a decline code only). */
async function move(
  tx: TenantTx,
  row: BookingFeeRow,
  from: readonly BookingFeeStatus[],
  change: BookingFeeChange,
): Promise<BookingFeeRow | undefined> {
  const moved = await moveBookingFee(tx, row.id, from, change);
  if (moved !== undefined && moved.status !== row.status) {
    await audit(tx, moved, BookingFeeStatusSchema.parse(row.status));
  }
  return moved;
}

async function audit(
  tx: TenantTx,
  row: BookingFeeRow,
  before: BookingFeeStatus | null,
  actor: Parameters<typeof appendAuditEntry>[1]['actor'] = { kind: 'system' },
): Promise<void> {
  await appendAuditEntry(tx, {
    actor,
    change: {
      action: 'payments.fee_changed',
      entity: { type: 'booking_fee', id: row.id },
      before: before === null ? null : { status: before },
      after: {
        status: BookingFeeStatusSchema.parse(row.status),
        amountCents: row.amountCents,
        bookingId: row.bookingId,
        failureCode: row.failureCode,
      },
    },
  });
}
