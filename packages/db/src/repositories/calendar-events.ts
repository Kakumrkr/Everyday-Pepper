import {
  CalendarSyncErrorSchema,
  TenantIdSchema,
  type CalendarSyncError,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookings,
  calendarConnections,
  calendarEventSyncs,
  clients,
  services,
  type CalendarConnectionRow,
  type CalendarEventSyncRow,
} from '../schema.js';
import type { Database } from '../client.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Google Calendar out (S71, ADR-0069 §10): the per-booking sync rows the trigger on `bookings`
// keeps (migration 0086), and where each booking's event is. Every function but the scan runs in
// the business's transaction (RLS keeps it to its rows). Nothing here holds client data or a
// token; the booking is read as it is when the worker writes it.

const Id = z.uuid();
const Version = z.number().int().min(1);

/** A row that is due: not written at its version, not waiting for a retry, not leased. */
function dueAt(now: Date) {
  return and(
    sql`${calendarEventSyncs.syncedVersion} IS DISTINCT FROM ${calendarEventSyncs.version}`,
    or(isNull(calendarEventSyncs.dueAt), lte(calendarEventSyncs.dueAt, now)),
    or(isNull(calendarEventSyncs.leasedUntil), lte(calendarEventSyncs.leasedUntil, now)),
  );
}

/**
 * Queues the staff member's bookings that start in [from, to) and aren't cancelled (AC-X-171: the
 * grant's 60 days), or raises their version when queued already. Returns how many.
 */
export async function queueUpcomingBookingSyncs(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
  range: { from: Date; to: Date },
): Promise<number> {
  const result = await tx.execute(sql`
    INSERT INTO calendar_event_syncs (id, booking_id)
    SELECT gen_random_uuid(), b.id FROM bookings b
    WHERE b.staff_member_id = ${Id.parse(staffMemberId)}
      AND b.status <> 'cancelled'
      AND b.starts_at >= ${range.from.toISOString()}::timestamptz
      AND b.starts_at < ${range.to.toISOString()}::timestamptz
    ON CONFLICT (tenant_id, booking_id) DO UPDATE
      SET version = calendar_event_syncs.version + 1, due_at = NULL, attempts = 0,
        last_error = NULL`);
  return result.rowCount ?? 0;
}

/**
 * Makes every waiting write of the business due now (a reconnect, AC-X-170: what waited for it
 * goes out at the next pass).
 */
export async function wakeCalendarEventSyncs(tx: TenantTx): Promise<void> {
  await tx
    .update(calendarEventSyncs)
    .set({ dueAt: null, attempts: 0 })
    .where(sql`${calendarEventSyncs.syncedVersion} IS DISTINCT FROM ${calendarEventSyncs.version}`);
}

/**
 * The events in a calendar that no longer exists (deleted in Google, AC-X-170, or removed at a
 * disconnect): forgotten, and their bookings queued again, so each is written where it belongs.
 */
export async function forgetCalendarEvents(
  tx: TenantTx,
  connectionId: string,
  calendarId: string | null,
): Promise<void> {
  await tx
    .update(calendarEventSyncs)
    .set({
      eventConnectionId: null,
      eventCalendarId: null,
      version: sql`${calendarEventSyncs.version} + 1`,
      dueAt: null,
      attempts: 0,
    })
    .where(
      and(
        eq(calendarEventSyncs.eventConnectionId, Id.parse(connectionId)),
        calendarId === null ? undefined : eq(calendarEventSyncs.eventCalendarId, calendarId),
      ),
    );
}

export interface DueCalendarEventSync {
  tenantId: TenantId;
  bookingId: string;
}

/** Bookings due a write, the longest waiting first (`job_scan('calendar')`: ids only). */
export async function listDueCalendarEventSyncs(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueCalendarEventSync[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const rows = await withJobScan(db, 'calendar', (tx) =>
    tx
      .select({ tenantId: calendarEventSyncs.tenantId, bookingId: calendarEventSyncs.bookingId })
      .from(calendarEventSyncs)
      .where(dueAt(now))
      .orderBy(
        sql`${calendarEventSyncs.dueAt} ASC NULLS FIRST`,
        asc(calendarEventSyncs.updatedAt),
        asc(calendarEventSyncs.id),
      )
      .limit(max),
  );
  return rows.map((row) => ({
    tenantId: TenantIdSchema.parse(row.tenantId),
    bookingId: row.bookingId,
  }));
}

/**
 * Claims a booking's row for one write until `now + leaseMs` (AC-X-169: one writer at a time),
 * with the version it will write. `undefined` when it isn't due (written, waiting, or leased).
 */
export async function claimCalendarEventSync(
  tx: TenantTx,
  bookingId: string,
  now: Date,
  leaseMs: number,
): Promise<CalendarEventSyncRow | undefined> {
  const [row] = await tx
    .update(calendarEventSyncs)
    .set({ leasedUntil: new Date(now.getTime() + z.number().int().min(1).parse(leaseMs)) })
    .where(and(eq(calendarEventSyncs.bookingId, Id.parse(bookingId)), dueAt(now)))
    .returning();
  return row;
}

/** Where a booking's event is after a write: a connection's calendar, or nowhere. */
export interface EventPlacement {
  connectionId: string;
  calendarId: string;
}

/**
 * Records a write of `version` (AC-X-169): where the event is now, the lease and the error
 * cleared. A change made meanwhile raised the version, so the row stays due for it.
 */
export async function recordCalendarEventWritten(
  tx: TenantTx,
  claimed: Pick<CalendarEventSyncRow, 'id' | 'version'>,
  placement: EventPlacement | null,
): Promise<void> {
  await tx
    .update(calendarEventSyncs)
    .set({
      syncedVersion: Version.parse(claimed.version),
      eventConnectionId: placement === null ? null : Id.parse(placement.connectionId),
      eventCalendarId: placement?.calendarId ?? null,
      leasedUntil: null,
      attempts: 0,
      lastError: null,
      dueAt: null,
    })
    .where(eq(calendarEventSyncs.id, Id.parse(claimed.id)));
}

/**
 * Records a failed write (AC-X-170): the code, the next try at `retryAt`, the lease given back.
 * `placement`, when given, is where the event is now (an old one removed before the failure).
 */
export async function recordCalendarEventFailure(
  tx: TenantTx,
  claimed: Pick<CalendarEventSyncRow, 'id'>,
  error: CalendarSyncError,
  retryAt: Date,
  placement?: EventPlacement | null,
): Promise<void> {
  await tx
    .update(calendarEventSyncs)
    .set({
      lastError: CalendarSyncErrorSchema.parse(error),
      dueAt: retryAt,
      leasedUntil: null,
      attempts: sql`${calendarEventSyncs.attempts} + 1`,
      ...(placement !== undefined && {
        eventConnectionId: placement === null ? null : Id.parse(placement.connectionId),
        eventCalendarId: placement?.calendarId ?? null,
      }),
    })
    .where(eq(calendarEventSyncs.id, Id.parse(claimed.id)));
}

export async function findCalendarEventSyncOfBooking(
  tx: TenantTx,
  bookingId: string,
): Promise<CalendarEventSyncRow | undefined> {
  const [row] = await tx
    .select()
    .from(calendarEventSyncs)
    .where(eq(calendarEventSyncs.bookingId, Id.parse(bookingId)));
  return row;
}

/** What a booking's event shows, read when it is written (D-3); `undefined`: the booking is gone. */
export interface BookingEventSource {
  id: string;
  staffMemberId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  serviceName: string;
  clientName: string;
}

export async function findBookingEventSource(
  tx: TenantTx,
  bookingId: string,
): Promise<BookingEventSource | undefined> {
  const [row] = await tx
    .select({
      id: bookings.id,
      staffMemberId: bookings.staffMemberId,
      status: bookings.status,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      serviceName: services.name,
      clientName: clients.name,
    })
    .from(bookings)
    .innerJoin(
      services,
      and(eq(services.tenantId, bookings.tenantId), eq(services.id, bookings.serviceId)),
    )
    .innerJoin(
      clients,
      and(eq(clients.tenantId, bookings.tenantId), eq(clients.id, bookings.clientId)),
    )
    .where(eq(bookings.id, Id.parse(bookingId)));
  return row;
}

/**
 * Keeps the "Pepper bookings" calendar just made (AC-X-167), unless the connection was reconnected
 * meanwhile or another worker stored one first: answers the calendar the connection has now.
 */
export async function storeBookingsCalendar(
  tx: TenantTx,
  claimed: Pick<CalendarConnectionRow, 'id' | 'generation'>,
  calendarId: string,
): Promise<string | null> {
  const [stored] = await tx
    .update(calendarConnections)
    .set({ bookingsCalendarId: z.string().min(1).max(1024).parse(calendarId) })
    .where(
      and(
        eq(calendarConnections.id, Id.parse(claimed.id)),
        eq(calendarConnections.generation, claimed.generation),
        isNull(calendarConnections.bookingsCalendarId),
      ),
    )
    .returning({ calendarId: calendarConnections.bookingsCalendarId });
  if (stored !== undefined) return stored.calendarId;
  const [now] = await tx
    .select({ calendarId: calendarConnections.bookingsCalendarId })
    .from(calendarConnections)
    .where(eq(calendarConnections.id, Id.parse(claimed.id)));
  return now?.calendarId ?? null;
}

/** Forgets a "Pepper bookings" calendar Google no longer has (AC-X-170): it is made again. */
export async function clearBookingsCalendar(
  tx: TenantTx,
  connectionId: string,
  calendarId: string,
): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ bookingsCalendarId: null })
    .where(
      and(
        eq(calendarConnections.id, Id.parse(connectionId)),
        eq(calendarConnections.bookingsCalendarId, calendarId),
      ),
    );
  await forgetCalendarEvents(tx, connectionId, calendarId);
}
