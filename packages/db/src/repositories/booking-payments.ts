import {
  BookingPaymentKindSchema,
  BookingPaymentStatusSchema,
  DepositRefundHoursSchema,
  PaymentProviderSchema,
  StripeAccountIdSchema,
  StripeCustomerIdSchema,
  StripeIntentIdSchema,
  StripeRefundIdSchema,
  TenantIdSchema,
  type BookingPaymentKind,
  type BookingPaymentStatus,
  type PaymentProvider,
  type TenantId,
} from '@pepper/contracts';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { bookingPayments, type BookingPaymentRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Booking page payments (S66, ADR-0068 §6): one per booking request, Stripe's ids only. Every
// function runs in the business's transaction (RLS keeps it to its rows), except
// `listOpenBookingPayments`, the sweep's definer lookup.

const Id = z.uuid();

export interface NewBookingPayment {
  requestId: string;
  provider: PaymentProvider;
  livemode: boolean;
  kind: BookingPaymentKind;
  intentId: string;
  customerId: string;
  accountId: string;
  amountCents: number;
  refundHours: number;
}

/**
 * Stores a request's payment, or answers `undefined` when the request already has one (two taps
 * at once: the first insert wins; Stripe's keys made the same intent for both).
 */
export async function insertBookingPayment(
  tx: TenantTx,
  input: NewBookingPayment,
): Promise<BookingPaymentRow | undefined> {
  const [row] = await tx
    .insert(bookingPayments)
    .values({
      requestId: Id.parse(input.requestId),
      provider: PaymentProviderSchema.parse(input.provider),
      livemode: input.livemode,
      kind: BookingPaymentKindSchema.parse(input.kind),
      intentId: StripeIntentIdSchema.parse(input.intentId),
      customerId: StripeCustomerIdSchema.parse(input.customerId),
      accountId: StripeAccountIdSchema.parse(input.accountId),
      amountCents: z.number().int().min(0).parse(input.amountCents),
      refundHours: DepositRefundHoursSchema.parse(input.refundHours),
    })
    .onConflictDoNothing({ target: [bookingPayments.tenantId, bookingPayments.requestId] })
    .returning();
  return row;
}

interface Lock {
  lock?: boolean;
}

async function first(
  tx: TenantTx,
  where: ReturnType<typeof eq>,
  options: Lock,
): Promise<BookingPaymentRow | undefined> {
  const query = tx.select().from(bookingPayments).where(where).limit(1);
  const [row] = options.lock === true ? await query.for('update') : await query;
  return row;
}

/** The payment made for a booking request. */
export function findBookingPaymentByRequest(
  tx: TenantTx,
  requestId: string,
  options: Lock = {},
): Promise<BookingPaymentRow | undefined> {
  return first(tx, eq(bookingPayments.requestId, Id.parse(requestId)), options);
}

/** The payment a booking was made with. */
export function findBookingPaymentByBooking(
  tx: TenantTx,
  bookingId: string,
  options: Lock = {},
): Promise<BookingPaymentRow | undefined> {
  return first(tx, eq(bookingPayments.bookingId, Id.parse(bookingId)), options);
}

export function findBookingPayment(
  tx: TenantTx,
  id: string,
  options: Lock = {},
): Promise<BookingPaymentRow | undefined> {
  return first(tx, eq(bookingPayments.id, Id.parse(id)), options);
}

export interface BookingPaymentChange {
  status: BookingPaymentStatus;
  bookingId?: string;
  refundId?: string;
  bookedAt?: Date;
  capturedAt?: Date;
  settledAt?: Date;
}

/**
 * Moves a payment to `change.status` only from one of `from` (so two workers, or a retry, can't
 * move it twice); answers the row after, or `undefined` when it wasn't in one of them.
 */
export async function moveBookingPayment(
  tx: TenantTx,
  id: string,
  from: readonly BookingPaymentStatus[],
  change: BookingPaymentChange,
): Promise<BookingPaymentRow | undefined> {
  const [row] = await tx
    .update(bookingPayments)
    .set({
      status: BookingPaymentStatusSchema.parse(change.status),
      ...(change.bookingId !== undefined && { bookingId: Id.parse(change.bookingId) }),
      ...(change.refundId !== undefined && {
        refundId: StripeRefundIdSchema.parse(change.refundId),
      }),
      ...(change.bookedAt !== undefined && { bookedAt: change.bookedAt }),
      ...(change.capturedAt !== undefined && { capturedAt: change.capturedAt }),
      ...(change.settledAt !== undefined && { settledAt: change.settledAt }),
    })
    .where(
      and(
        eq(bookingPayments.id, Id.parse(id)),
        inArray(
          bookingPayments.status,
          from.map((status) => BookingPaymentStatusSchema.parse(status)),
        ),
      ),
    )
    .returning();
  return row;
}

/** Marks a payment looked at by the sweep without a change, so the next run takes others first. */
export async function touchBookingPayment(tx: TenantTx, id: string): Promise<void> {
  await tx
    .update(bookingPayments)
    .set({ updatedAt: sql`now()` })
    .where(eq(bookingPayments.id, Id.parse(id)));
}

/**
 * Payments the sweep looks after (made `ageMs` ago and not booked; voided but not yet let go at
 * Stripe; a refund Stripe left pending; the last two untouched for `ageMs`), by the database's clock, oldest first, across businesses (AC-X-116):
 * their business and id only.
 */
export async function listOpenBookingPayments(
  db: Database,
  ageMs: number,
  limit: number,
): Promise<{ tenantId: TenantId; id: string }[]> {
  const age = `${String(Math.max(0, Math.trunc(ageMs)))} milliseconds`;
  const result = await db.execute<{ tenant_id: string; id: string }>(
    sql`SELECT tenant_id, id FROM open_booking_payments(${age}::interval, ${Math.trunc(limit)})`,
  );
  return result.rows.map((row) => ({
    tenantId: TenantIdSchema.parse(row.tenant_id),
    id: Id.parse(row.id),
  }));
}
