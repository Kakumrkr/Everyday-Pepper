import { and, desc, gt, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiActionProposals, bookings, clients } from '../schema.js';
import { NUDGE_ACTION } from './feed.js';
import type { TenantTx } from '../tenant.js';

// Post-visit review requests (S55.2, ADR-0059): which clients the morning pass may ask for a
// review. The rules are here because they are all about rows: the visit, the client's reach and
// their last request.

const Id = z.uuid();

/** The dial action and target of a client's review request: one a client per quiet window. */
export const REVIEW_REQUEST_ACTION = 'message.review_request';
export const reviewTargetKey = (clientId: string) => `review:client:${Id.parse(clientId)}`;

/** A client's latest visit that may be followed by a review request. */
export interface ReviewCandidate {
  bookingId: string;
  clientId: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: Date;
  /** As the client typed it (untrusted text). */
  clientName: string;
}

/** No review request within this many days of a nudge or a regular's offer: one a week. */
const MARKETING_QUIET_DAYS = 7;

/** At most this many visits are read in one pass (a busy two days). */
const VISITS_READ_MAX = 1_000;

/**
 * Up to `limit` clients to ask for a review, the earliest visit first, each by their latest
 * visit that started after `since` and has ended by `now`. A visit counts when it was kept
 * (confirmed or completed; not cancelled, not a no-show) and is not imported history. The
 * client is not deleted, has an email, has not opted out of marketing email, and got no review
 * request within `quietDays` (a pending, sent, turned down or expired one all count; a
 * superseded one reached no one), nor a rebooking nudge or a regular's offer in the last
 * `MARKETING_QUIET_DAYS` (one marketing email a week at most, as for nudges and offers).
 */
export async function listReviewCandidates(
  tx: TenantTx,
  window: { now: Date; since: Date; quietDays: number; limit: number },
): Promise<ReviewCandidate[]> {
  const max = z.number().int().min(1).max(200).parse(window.limit);
  const quietDays = z.number().int().min(1).max(365).parse(window.quietDays);
  const target = sql`'review:client:' || ${bookings.clientId}::text`;
  const rows = await tx
    .select({
      bookingId: bookings.id,
      clientId: bookings.clientId,
      serviceId: bookings.serviceId,
      staffMemberId: bookings.staffMemberId,
      startsAt: bookings.startsAt,
      clientName: clients.name,
    })
    .from(bookings)
    .innerJoin(clients, sql`${clients.id} = ${bookings.clientId}`)
    .where(
      and(
        inArray(bookings.status, ['confirmed', 'completed']),
        ne(bookings.source, 'import'),
        gt(bookings.startsAt, window.since),
        lte(bookings.endsAt, window.now),
        isNull(clients.deletedAt),
        sql`${clients.email} IS NOT NULL`,
        isNull(clients.emailOptOutAt),
        sql`NOT EXISTS (SELECT 1 FROM ${aiActionProposals} p WHERE p.action = ${NUDGE_ACTION} AND p.target_key = 'nudge:client:' || ${bookings.clientId}::text AND p.status <> 'superseded' AND p.created_at > ${window.now.toISOString()}::timestamptz - make_interval(days => ${MARKETING_QUIET_DAYS}))`,
        sql`NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.client_id = ${bookings.clientId} AND o.source = 'regular' AND o.created_at > ${window.now.toISOString()}::timestamptz - make_interval(days => ${MARKETING_QUIET_DAYS}))`,
        sql`NOT EXISTS (SELECT 1 FROM ${aiActionProposals} p WHERE p.action = ${REVIEW_REQUEST_ACTION} AND p.target_key = ${target} AND p.status <> 'superseded' AND p.created_at > ${window.now.toISOString()}::timestamptz - make_interval(days => ${quietDays}))`,
      ),
    )
    .orderBy(desc(bookings.startsAt), desc(bookings.id))
    .limit(VISITS_READ_MAX);
  // Each client once, by their latest visit; then the earliest of those first.
  const latest = new Map<string, ReviewCandidate>();
  for (const row of rows) if (!latest.has(row.clientId)) latest.set(row.clientId, row);
  return [...latest.values()]
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .slice(0, max);
}
