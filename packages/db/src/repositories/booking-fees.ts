import {
  BookingFeeStatusSchema,
  PaymentProviderSchema,
  StripePaymentIntentIdSchema,
  StripeRefundIdSchema,
  UserIdSchema,
  type BookingFeeStatus,
  type PaymentProvider,
} from '@pepper/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { bookingFees, type BookingFeeRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// No-show fees by approval (S68, ADR-0068 amendment): one per booking, the record a dispute is
// answered from. Every function runs in the business's transaction (RLS keeps it to its rows).

const Id = z.uuid();
const FailureCode = z.string().regex(/^[a-z0-9_]{1,64}$/);

export interface NewBookingFee {
  bookingId: string;
  bookingPaymentId: string;
  provider: PaymentProvider;
  livemode: boolean;
  amountCents: number;
  policySentence: string;
  agreedAt: Date;
  approvedBy: string;
  approvedAt: Date;
}

/** Stores an approved fee, or answers `undefined` when the booking already has one. */
export async function insertBookingFee(
  tx: TenantTx,
  input: NewBookingFee,
): Promise<BookingFeeRow | undefined> {
  const [row] = await tx
    .insert(bookingFees)
    .values({
      bookingId: Id.parse(input.bookingId),
      bookingPaymentId: Id.parse(input.bookingPaymentId),
      provider: PaymentProviderSchema.parse(input.provider),
      livemode: input.livemode,
      amountCents: z.number().int().min(50).parse(input.amountCents),
      policySentence: z.string().min(1).max(500).parse(input.policySentence),
      agreedAt: input.agreedAt,
      approvedBy: UserIdSchema.parse(input.approvedBy),
      approvedAt: input.approvedAt,
    })
    .onConflictDoNothing({ target: [bookingFees.tenantId, bookingFees.bookingId] })
    .returning();
  return row;
}

export async function findBookingFee(
  tx: TenantTx,
  id: string,
  options: { lock?: boolean } = {},
): Promise<BookingFeeRow | undefined> {
  const query = tx
    .select()
    .from(bookingFees)
    .where(eq(bookingFees.id, Id.parse(id)))
    .limit(1);
  const [row] = options.lock === true ? await query.for('update') : await query;
  return row;
}

/** The fee of a booking, if one was approved. */
export async function findBookingFeeByBooking(
  tx: TenantTx,
  bookingId: string,
): Promise<BookingFeeRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingFees)
    .where(eq(bookingFees.bookingId, Id.parse(bookingId)))
    .limit(1);
  return row;
}

/** A business's fees, oldest first (the export). */
export function listBookingFees(tx: TenantTx): Promise<BookingFeeRow[]> {
  return tx.select().from(bookingFees).orderBy(bookingFees.createdAt, bookingFees.id);
}

export interface BookingFeeChange {
  status: BookingFeeStatus;
  intentId?: string;
  refundId?: string;
  failureCode?: string;
  chargedAt?: Date;
  settledAt?: Date;
}

/**
 * Moves a fee to `change.status` only from one of `from` (two workers, an Undo racing the charge,
 * or a retry can't move it twice); answers the row after, or `undefined` when it wasn't in one.
 */
export async function moveBookingFee(
  tx: TenantTx,
  id: string,
  from: readonly BookingFeeStatus[],
  change: BookingFeeChange,
): Promise<BookingFeeRow | undefined> {
  const [row] = await tx
    .update(bookingFees)
    .set({
      status: BookingFeeStatusSchema.parse(change.status),
      ...(change.intentId !== undefined && {
        intentId: StripePaymentIntentIdSchema.parse(change.intentId),
      }),
      ...(change.refundId !== undefined && {
        refundId: StripeRefundIdSchema.parse(change.refundId),
      }),
      ...(change.failureCode !== undefined && {
        failureCode: FailureCode.parse(change.failureCode),
      }),
      ...(change.chargedAt !== undefined && { chargedAt: change.chargedAt }),
      ...(change.settledAt !== undefined && { settledAt: change.settledAt }),
    })
    .where(
      and(
        eq(bookingFees.id, Id.parse(id)),
        inArray(
          bookingFees.status,
          from.map((status) => BookingFeeStatusSchema.parse(status)),
        ),
      ),
    )
    .returning();
  return row;
}
