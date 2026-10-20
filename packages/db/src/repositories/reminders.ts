import { BookingIdSchema, TenantIdSchema, type BookingId, type TenantId } from '@pepper/contracts';
import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { bookingReminders, type BookingReminderRow } from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Booking reminders (W6, ADR-0025): one row per confirmed booking whose reminder email is
// still to be sent. The booking services plan and remove rows in the booking's transaction;
// the reminder job lists due rows across businesses (`job_scan`, ids only) and takes each one
// under its business's tenant.

export interface PlannedReminder {
  bookingId: BookingId;
  /** When the reminder is due. */
  dueAt: Date;
  /** The booking's start the reminder is for. */
  startsAt: Date;
}

/** Plans (or re-plans) the transaction's tenant's reminder of a booking. */
export async function planBookingReminder(tx: TenantTx, input: PlannedReminder): Promise<void> {
  const id = BookingIdSchema.parse(input.bookingId);
  await tx
    .insert(bookingReminders)
    .values({ id, dueAt: input.dueAt, startsAt: input.startsAt })
    .onConflictDoUpdate({
      target: bookingReminders.id,
      set: { dueAt: input.dueAt, startsAt: input.startsAt },
    });
}

/** Removes a booking's planned reminder, if any. */
export async function removeBookingReminder(tx: TenantTx, bookingId: BookingId): Promise<void> {
  await tx
    .delete(bookingReminders)
    .where(eq(bookingReminders.id, BookingIdSchema.parse(bookingId)));
}

/** The transaction's tenant's planned reminder of a booking. */
export async function findBookingReminder(
  tx: TenantTx,
  bookingId: BookingId,
): Promise<BookingReminderRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingReminders)
    .where(eq(bookingReminders.id, BookingIdSchema.parse(bookingId)));
  return row;
}

/** A due reminder and its business, as the reminder job's scan lists it. */
export interface DueReminder {
  bookingId: BookingId;
  tenantId: TenantId;
}

/**
 * Up to `limit` reminders due at `now`, across businesses, the earliest due first: ids only,
 * read in the reminder job's scan (`withJobScan`).
 */
export async function listDueBookingReminders(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueReminder[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const rows = await withJobScan(db, 'reminders', (tx) =>
    tx
      .select({ id: bookingReminders.id, tenantId: bookingReminders.tenantId })
      .from(bookingReminders)
      .where(lte(bookingReminders.dueAt, now))
      .orderBy(asc(bookingReminders.dueAt))
      .limit(max),
  );
  return rows.map((row) => ({
    bookingId: BookingIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

/**
 * Takes a booking's reminder if it is due at `now`: removes the row and returns it. A
 * concurrent taker waits for the row lock and then finds nothing, so a reminder is taken once;
 * whatever the caller queues in the same transaction commits with the removal, or neither does.
 */
export async function takeDueBookingReminder(
  tx: TenantTx,
  bookingId: BookingId,
  now: Date,
): Promise<BookingReminderRow | undefined> {
  const [row] = await tx
    .delete(bookingReminders)
    .where(
      and(
        eq(bookingReminders.id, BookingIdSchema.parse(bookingId)),
        lte(bookingReminders.dueAt, now),
      ),
    )
    .returning();
  return row;
}
