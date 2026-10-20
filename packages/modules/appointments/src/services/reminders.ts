import { BookingIdSchema } from '@pepper/contracts';
import {
  planBookingReminder,
  removeBookingReminder,
  type BookingRow,
  type TenantTx,
} from '@pepper/db';

// Booking reminders (W6, AC-W6-1, ADR-0025): every confirmed booking has a reminder email
// planned for 24 hours before it starts. The booking services keep the plan in step inside the
// booking's own transaction, so a cancelled booking never keeps one and a moved booking's
// reminder moves with it. A booking made or moved less than 24 hours ahead gets none: its
// confirmation has just been sent.

/** How long before a booking's start its reminder is due. */
export const REMINDER_LEAD_MS = 24 * 60 * 60_000;

/**
 * Plans, moves or removes the reminder of a booking just written (`row` as it is now), as of
 * `now` (ms). Call it in the transaction that wrote the booking.
 */
export async function keepReminderInStep(
  tx: TenantTx,
  row: BookingRow,
  now: number,
): Promise<void> {
  const bookingId = BookingIdSchema.parse(row.id);
  const dueAt = row.startsAt.getTime() - REMINDER_LEAD_MS;
  if (row.status === 'confirmed' && dueAt > now) {
    await planBookingReminder(tx, { bookingId, dueAt: new Date(dueAt), startsAt: row.startsAt });
  } else {
    await removeBookingReminder(tx, bookingId);
  }
}
