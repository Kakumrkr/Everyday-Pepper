import { and, eq, gte, isNull, lt, ne, sql } from 'drizzle-orm';
import { aiActionExecutions, bookings, clients, services } from '../schema.js';
import { NUDGE_ACTION } from './feed.js';
import type { TenantTx } from '../tenant.js';

// Proof of value (S55, ADR-0058): what the week card reads. The rules (what counts, the
// minutes) are the appointments module's; here are only the rows of the window.

/** A visit booked in the window, with what the week card needs to sort it. */
export interface WeekBookingRow {
  id: string;
  clientId: string;
  source: string;
  /** The price the visit was booked at, else its service's (cents); `null`: unpriced. */
  priceCents: number | null;
  /** A claimed waitlist or regular's offer made it (a freed time filled). */
  filled: boolean;
  /** A rebooking or win-back nudge was sent to its client within `regularBackDays` before. */
  nudged: boolean;
}

/**
 * Every visit booked from `from` (inclusive) to `to` (exclusive) that still stands (not
 * cancelled), of a client who is not deleted; imported history is not "booked", so it is left
 * out. Oldest first, so a client's first booking after a nudge is the one that counts.
 */
export async function listWeekBookings(
  tx: TenantTx,
  window: { from: Date; to: Date; regularBackDays: number },
): Promise<WeekBookingRow[]> {
  const rows = await tx
    .select({
      id: bookings.id,
      clientId: bookings.clientId,
      source: bookings.source,
      priceCents: sql<
        number | null
      >`coalesce(${bookings.priceFromCents}, ${services.priceFromCents})`,
      filled: sql<boolean>`EXISTS (
        SELECT 1 FROM waitlist_offers o
        WHERE o.booking_id = ${bookings.id} AND o.status = 'claimed'
      )`,
      nudged: sql<boolean>`EXISTS (
        SELECT 1 FROM ai_action_executions e
        WHERE e.action = ${NUDGE_ACTION}
          AND e.status = 'done'
          AND e.entity_type = 'client'
          AND e.entity_id = ${bookings.clientId}
          AND e.created_at <= ${bookings.createdAt}
          AND e.created_at > ${bookings.createdAt} - make_interval(days => ${window.regularBackDays}::int)
      )`,
    })
    .from(bookings)
    .innerJoin(clients, eq(clients.id, bookings.clientId))
    .leftJoin(services, eq(services.id, bookings.serviceId))
    .where(
      and(
        gte(bookings.createdAt, window.from),
        lt(bookings.createdAt, window.to),
        ne(bookings.status, 'cancelled'),
        ne(bookings.source, 'import'),
        isNull(clients.deletedAt),
      ),
    )
    .orderBy(bookings.createdAt, bookings.id);
  return rows;
}

/** How many actions of each kind the AI did (and nobody undid) from `from` to `to`. */
export async function countWeekActions(
  tx: TenantTx,
  window: { from: Date; to: Date },
): Promise<Map<string, number>> {
  const rows = await tx
    .select({
      action: aiActionExecutions.action,
      count: sql<number>`count(*)::int`,
    })
    .from(aiActionExecutions)
    .where(
      and(
        eq(aiActionExecutions.status, 'done'),
        gte(aiActionExecutions.createdAt, window.from),
        lt(aiActionExecutions.createdAt, window.to),
      ),
    )
    .groupBy(aiActionExecutions.action);
  return new Map(rows.map((row) => [row.action, row.count]));
}
