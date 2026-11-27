import {
  BookingIdSchema,
  reminderSettingsFrom,
  UtcDateTimeSchema,
  type Booking,
  type BookingId,
} from '@pepper/contracts';
import { requirePermission, systemClock, type Actor } from '@pepper/core';
import {
  findBookingPaymentByBooking,
  findCurrentTenant,
  lockBooking,
  type BookingRow,
  type TenantTx,
} from '@pepper/db';
import { BookingNotFoundError, BookingNotReleasableError } from '../errors.js';
import { changeBookingIn, type ChangeBookingOptions } from './bookings.js';
import { releaseCheck } from './release-check.js';

// Releasing a visit from its card (S78.2, ADR-0071 §S78.2; AC-X-209): the rules are in
// `release-check.ts`.

/** What the release card shows of the visit (the tool's words read the rest). */
export interface ReleasableVisit {
  row: BookingRow;
  /** A paid deposit that the release refunds in full. */
  refundsDeposit: boolean;
}

/**
 * The visit, locked, when it may be released now (`BookingNotReleasableError` otherwise): the
 * card's dry run and the release itself read it the same way, so a confirm that landed first
 * refuses both.
 */
export async function releasableVisitIn(
  tx: TenantTx,
  bookingId: BookingId,
  now: number,
  shownStartsAt?: number,
): Promise<ReleasableVisit> {
  const id = BookingIdSchema.parse(bookingId);
  const row = await lockBooking(tx, id);
  if (row === undefined) throw new BookingNotFoundError();
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new BookingNotFoundError();
  const check = releaseCheck(
    row,
    reminderSettingsFrom(tenant.reminderSettings),
    now,
    shownStartsAt,
  );
  if (check !== 'ok') throw new BookingNotReleasableError(check);
  const payment = await findBookingPaymentByBooking(tx, id);
  const refundsDeposit =
    payment?.kind === 'deposit' && (payment.status === 'booked' || payment.status === 'captured');
  return { row, refundsDeposit };
}

/**
 * Releases the visit (AC-X-209), in the caller's transaction: checked again under its lock at
 * the time the card showed (`startsAt`), then cancelled as the business's cancel with the
 * release email, `options.onCancelled` settling a deposit (the tool refunds it in full), and the
 * freed time asked to be matched (the fill loop, ADR-0056). The trust layer's receipt records it
 * as a release; the booking's audit as the business's cancel.
 */
export async function releaseUnconfirmedBookingIn(
  tx: TenantTx,
  actor: Actor,
  input: { bookingId: BookingId; startsAt: string },
  options: ChangeBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(input.bookingId);
  const now = (options.clock ?? systemClock).now().getTime();
  const shown = Date.parse(UtcDateTimeSchema.parse(input.startsAt));
  const { refundsDeposit } = await releasableVisitIn(tx, id, now, shown);
  return changeBookingIn(
    tx,
    actor,
    id,
    { status: 'cancelled', notifyClient: true },
    { ...options, released: { refunded: refundsDeposit } },
  );
}
