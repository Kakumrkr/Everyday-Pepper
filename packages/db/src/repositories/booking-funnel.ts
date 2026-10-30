import {
  BOOKING_FUNNEL_STEPS,
  BookingFunnelEventInputSchema,
  type BookingFunnelCounts,
  type BookingFunnelEventInput,
} from '@pepper/contracts';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { bookingFunnelEvents } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The booking page's funnel (S47, ADR-0047, AC-W8-9): a random visit id, a step and a time.

/** Records that a visit entered a step, once per visit and step; whether this call did. */
export async function recordFunnelStep(
  tx: TenantTx,
  event: BookingFunnelEventInput,
): Promise<boolean> {
  const { visitId, step } = BookingFunnelEventInputSchema.parse(event);
  const rows = await tx
    .insert(bookingFunnelEvents)
    .values({ visitId, step })
    .onConflictDoNothing({
      target: [bookingFunnelEvents.tenantId, bookingFunnelEvents.visitId, bookingFunnelEvents.step],
    })
    .returning({ id: bookingFunnelEvents.id });
  return rows.length > 0;
}

/** How many visits entered each step in [from, to); every step is present, 0 when none. */
export async function countFunnelSteps(
  tx: TenantTx,
  range: { from: Date; to: Date },
): Promise<BookingFunnelCounts> {
  const rows = await tx
    .select({ step: bookingFunnelEvents.step, visits: count() })
    .from(bookingFunnelEvents)
    .where(
      and(
        eq(bookingFunnelEvents.tenantId, sql`current_tenant_id()`),
        gte(bookingFunnelEvents.occurredAt, range.from),
        lt(bookingFunnelEvents.occurredAt, range.to),
      ),
    )
    .groupBy(bookingFunnelEvents.step);
  const counts = Object.fromEntries(BOOKING_FUNNEL_STEPS.map((step) => [step, 0]));
  for (const row of rows) counts[row.step] = row.visits;
  return counts as BookingFunnelCounts;
}
