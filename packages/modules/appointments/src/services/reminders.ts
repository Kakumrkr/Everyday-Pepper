import { BookingIdSchema, OutboxDedupeKeySchema, TenantIdSchema } from '@pepper/contracts';
import { queueEmail, type Clock } from '@pepper/core';
import {
  findCurrentTenant,
  listDueBookingReminders,
  lockBooking,
  planBookingReminder,
  removeBookingReminder,
  takeDueBookingReminder,
  withTenant,
  type BookingRow,
  type Database,
  type DueReminder,
  type TenantTx,
} from '@pepper/db';
import { reminderEmail } from '../emails.js';
import { emailDetailsOf } from './notices.js';

// Booking reminders (W6, AC-W6-1, ADR-0025): every confirmed booking has a reminder email
// planned for 24 hours before it starts. The booking services keep the plan in step inside the
// booking's own transaction, so a cancelled booking never keeps one and a moved booking's
// reminder moves with it. A booking made or moved less than 24 hours ahead gets none: its
// confirmation has just been sent. The worker's reminder job sends what is due
// (`sendDueReminders`): it checks the booking again under its lock and queues the email in the
// outbox in the same transaction that takes the reminder, so each is queued at most once.

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

/** Reminders the job lists at a time. */
export const REMINDER_BATCH = 100;
/** Batches per pass at most, so one pass ends even if reminders keep falling due. */
export const REMINDER_BATCHES_PER_PASS = 20;

export interface ReminderOptions {
  /** Seals the queued email (the outbox key, ADR-0024). */
  key: Buffer;
  clock: Clock;
}

/** What handling one due reminder did. */
export type ReminderResult = 'queued' | 'skipped';

/**
 * Handles one due reminder under its business's tenant: locks the booking (so a concurrent
 * cancellation or move either commits first and is seen, or waits), takes the reminder, and
 * queues the email when the booking is still confirmed at the planned start, has not started,
 * and its client has an email address. `skipped`: none of that (the reminder is gone either
 * way), or another worker took it first.
 */
export async function sendDueReminder(
  db: Database,
  due: DueReminder,
  options: ReminderOptions,
): Promise<ReminderResult> {
  const bookingId = BookingIdSchema.parse(due.bookingId);
  const now = options.clock.now();
  return withTenant(db, TenantIdSchema.parse(due.tenantId), async (tx) => {
    // The booking first, then its reminder: the same order as every booking change.
    const booking = await lockBooking(tx, bookingId);
    const reminder = await takeDueBookingReminder(tx, bookingId, now);
    if (booking === undefined || reminder === undefined) return 'skipped';
    const startsAt = booking.startsAt.getTime();
    if (
      booking.status !== 'confirmed' ||
      startsAt !== reminder.startsAt.getTime() ||
      startsAt <= now.getTime()
    ) {
      return 'skipped';
    }
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) return 'skipped';
    const details = await emailDetailsOf(tx, tenant, booking);
    if (details.email === '') return 'skipped';
    const queued = await queueEmail(tx, reminderEmail(details), {
      key: options.key,
      // One reminder per booking and start, even if a reminder were somehow planned twice.
      dedupeKey: OutboxDedupeKeySchema.parse(`booking.reminder:${bookingId}:${String(startsAt)}`),
      now,
    });
    return queued === undefined ? 'skipped' : 'queued';
  });
}

/**
 * One pass of the reminder job: handles the reminders due now, across businesses, the earliest
 * first, in batches until none is left (a backlog after downtime clears in one pass, up to
 * `REMINDER_BATCHES_PER_PASS` batches). Every reminder handled is removed, queued or skipped,
 * so the next batch lists new ones. Returns how many emails it queued and skipped.
 */
export async function sendDueReminders(
  db: Database,
  options: ReminderOptions,
): Promise<{ queued: number; skipped: number }> {
  const totals = { queued: 0, skipped: 0 };
  for (let batch = 0; batch < REMINDER_BATCHES_PER_PASS; batch += 1) {
    const due = await listDueBookingReminders(db, options.clock.now(), REMINDER_BATCH);
    for (const reminder of due) {
      totals[await sendDueReminder(db, reminder, options)] += 1;
    }
    if (due.length < REMINDER_BATCH) break;
  }
  return totals;
}
