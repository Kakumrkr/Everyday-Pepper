import {
  BookingIdSchema,
  ReminderKindSchema,
  ReminderSettingsSchema,
  TenantIdSchema,
  type BookingId,
  type ReminderKind,
  type ReminderSettings,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { bookingReminders, tenants, type BookingReminderRow } from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Booking reminders (W6, ADR-0025; kinds S62): one row per confirmed booking and kind whose
// reminder is still to be sent. The booking services plan and remove rows in the booking's transaction;
// the reminder job lists due rows across businesses (`job_scan`, ids only) and takes each one
// under its business's tenant.

export interface PlannedReminder {
  bookingId: BookingId;
  /** Default `day_before`. */
  kind?: ReminderKind;
  /** When the reminder is due. */
  dueAt: Date;
  /** The booking's start the reminder is for. */
  startsAt: Date;
}

/** Plans (or re-plans) the transaction's tenant's reminder of a booking, of one kind. */
export async function planBookingReminder(tx: TenantTx, input: PlannedReminder): Promise<void> {
  const id = BookingIdSchema.parse(input.bookingId);
  const kind = ReminderKindSchema.parse(input.kind ?? 'day_before');
  await tx
    .insert(bookingReminders)
    .values({ id, kind, dueAt: input.dueAt, startsAt: input.startsAt })
    .onConflictDoUpdate({
      target: [bookingReminders.id, bookingReminders.kind],
      set: { dueAt: input.dueAt, startsAt: input.startsAt },
    });
}

/** Removes a booking's planned reminder of one kind, or of every kind, if any. */
export async function removeBookingReminder(
  tx: TenantTx,
  bookingId: BookingId,
  kind?: ReminderKind,
): Promise<void> {
  const id = eq(bookingReminders.id, BookingIdSchema.parse(bookingId));
  await tx
    .delete(bookingReminders)
    .where(
      kind === undefined
        ? id
        : and(id, eq(bookingReminders.kind, ReminderKindSchema.parse(kind))),
    );
}

/** The transaction's tenant's planned reminder of a booking (default: the day before). */
export async function findBookingReminder(
  tx: TenantTx,
  bookingId: BookingId,
  kind: ReminderKind = 'day_before',
): Promise<BookingReminderRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingReminders)
    .where(
      and(
        eq(bookingReminders.id, BookingIdSchema.parse(bookingId)),
        eq(bookingReminders.kind, ReminderKindSchema.parse(kind)),
      ),
    );
  return row;
}

/** The transaction's tenant's planned reminders of a booking, every kind. */
export async function listBookingReminders(
  tx: TenantTx,
  bookingId: BookingId,
): Promise<BookingReminderRow[]> {
  return tx
    .select()
    .from(bookingReminders)
    .where(eq(bookingReminders.id, BookingIdSchema.parse(bookingId)))
    .orderBy(asc(bookingReminders.dueAt));
}

/** A due reminder and its business, as the reminder job's scan lists it. */
export interface DueReminder {
  bookingId: BookingId;
  kind: ReminderKind;
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
      .select({
        id: bookingReminders.id,
        kind: bookingReminders.kind,
        tenantId: bookingReminders.tenantId,
      })
      .from(bookingReminders)
      .where(lte(bookingReminders.dueAt, now))
      .orderBy(asc(bookingReminders.dueAt))
      .limit(max),
  );
  return rows.map((row) => ({
    bookingId: BookingIdSchema.parse(row.id),
    kind: ReminderKindSchema.parse(row.kind),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

/**
 * Takes a booking's reminder of one kind if it is due at `now`: removes the row and returns it. A
 * concurrent taker waits for the row lock and then finds nothing, so a reminder is taken once;
 * whatever the caller queues in the same transaction commits with the removal, or neither does.
 */
export async function takeDueBookingReminder(
  tx: TenantTx,
  bookingId: BookingId,
  kind: ReminderKind,
  now: Date,
): Promise<BookingReminderRow | undefined> {
  const [row] = await tx
    .delete(bookingReminders)
    .where(
      and(
        eq(bookingReminders.id, BookingIdSchema.parse(bookingId)),
        eq(bookingReminders.kind, ReminderKindSchema.parse(kind)),
        lte(bookingReminders.dueAt, now),
      ),
    )
    .returning();
  return row;
}

/**
 * The transaction's business's reminder settings (S62, AC-X-75), each missing field at its
 * default; the defaults when the business isn't visible.
 */
export async function findReminderSettings(tx: TenantTx): Promise<ReminderSettings> {
  const [row] = await tx
    .select({ settings: tenants.reminderSettings })
    .from(tenants)
    .where(eq(tenants.id, sql`current_tenant_id()`));
  const parsed = ReminderSettingsSchema.safeParse(row?.settings ?? {});
  return parsed.success ? parsed.data : ReminderSettingsSchema.parse({});
}

/** Stores the transaction's business's reminder settings, every field. */
export async function setReminderSettings(
  tx: TenantTx,
  settings: ReminderSettings,
): Promise<void> {
  await tx
    .update(tenants)
    .set({ reminderSettings: ReminderSettingsSchema.parse(settings) })
    .where(eq(tenants.id, sql`current_tenant_id()`));
}
