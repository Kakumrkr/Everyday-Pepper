import {
  TenantIdSchema,
  WaitlistMatchIdSchema,
  WaitlistOfferStatusSchema,
  type BookingId,
  type ClientId,
  type ServiceId,
  type StaffMemberId,
  type TenantId,
  type WaitlistEntryId,
  type WaitlistMatchId,
  type WaitlistOfferId,
  type WaitlistOfferStatus,
} from '@pepper/contracts';
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookings,
  waitlistEntries,
  waitlistMatches,
  waitlistOffers,
  type WaitlistEntryRow,
  type WaitlistMatchRow,
  type WaitlistOfferRow,
} from '../schema.js';
import type { Database } from '../client.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// The smart waitlist (S37, ADR-0041): freed slots to match (`waitlist_matches`, written in the
// cancelling or moving transaction) and the offers made for them (`waitlist_offers`). Matches
// are found across businesses only by the read-only `job_scan('waitlist')` scan; everything
// else runs inside one business's transaction.

const Id = z.uuid();
const TokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');
const Limit = z.number().int().min(1).max(1000);

/** Attempts after which a failing match is given up (`failed`). */
export const WAITLIST_MATCH_MAX_ATTEMPTS = 5;

// Matches -----------------------------------------------------------------------------------

/** Asks for a freed slot to be matched, in the transaction that freed it. */
export async function insertWaitlistMatch(
  tx: TenantTx,
  slot: { bookingId: BookingId; staffMemberId: StaffMemberId; startsAt: Date; endsAt: Date },
): Promise<WaitlistMatchId> {
  const [row] = await tx
    .insert(waitlistMatches)
    .values({
      bookingId: Id.parse(slot.bookingId),
      staffMemberId: Id.parse(slot.staffMemberId),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    })
    .returning({ id: waitlistMatches.id });
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return WaitlistMatchIdSchema.parse(row!.id);
}

export interface DueWaitlistMatch {
  matchId: WaitlistMatchId;
  tenantId: TenantId;
}

/**
 * Pending matches due at `now` (not leased, or the lease ran out), across businesses: ids only,
 * oldest first.
 */
export async function listDueWaitlistMatches(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueWaitlistMatch[]> {
  const rows = await withJobScan(db, 'waitlist', (tx) =>
    tx
      .select({ id: waitlistMatches.id, tenantId: waitlistMatches.tenantId })
      .from(waitlistMatches)
      .where(
        and(
          eq(waitlistMatches.status, 'pending'),
          lte(waitlistMatches.availableAt, now),
          or(isNull(waitlistMatches.leaseUntil), lte(waitlistMatches.leaseUntil, now)),
        ),
      )
      .orderBy(asc(waitlistMatches.availableAt), asc(waitlistMatches.id))
      .limit(Limit.parse(limit)),
  );
  return rows.map((row) => ({
    matchId: WaitlistMatchIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

/**
 * Claims a due match for `leaseUntil` and counts the attempt; `undefined` when it is done, not
 * due, or leased by another worker. Commit the claim before working on it.
 */
export async function claimWaitlistMatch(
  tx: TenantTx,
  id: WaitlistMatchId,
  now: Date,
  leaseUntil: Date,
): Promise<WaitlistMatchRow | undefined> {
  const [row] = await tx
    .update(waitlistMatches)
    .set({ leaseUntil, attempts: sql`${waitlistMatches.attempts} + 1` })
    .where(
      and(
        eq(waitlistMatches.id, Id.parse(id)),
        eq(waitlistMatches.status, 'pending'),
        lte(waitlistMatches.availableAt, now),
        or(isNull(waitlistMatches.leaseUntil), lte(waitlistMatches.leaseUntil, now)),
      ),
    )
    .returning();
  return row;
}

/** The match with this id, locked until the transaction ends: a slot's claims take turns. */
export async function lockWaitlistMatch(
  tx: TenantTx,
  id: WaitlistMatchId,
): Promise<WaitlistMatchRow | undefined> {
  const [row] = await tx
    .select()
    .from(waitlistMatches)
    .where(eq(waitlistMatches.id, Id.parse(id)))
    .for('update');
  return row;
}

export type WaitlistMatchOutcome = 'offered' | 'proposed' | 'no_match' | 'too_soon' | 'failed';

/** Records what a match did; it is not run again. */
export async function finishWaitlistMatch(
  tx: TenantTx,
  id: WaitlistMatchId,
  outcome: WaitlistMatchOutcome,
): Promise<void> {
  await tx
    .update(waitlistMatches)
    .set({ status: 'done', outcome, leaseUntil: null })
    .where(eq(waitlistMatches.id, Id.parse(id)));
}

/** A match that failed is due again at `retryAt` (the attempt stays counted). */
export async function retryWaitlistMatch(
  tx: TenantTx,
  id: WaitlistMatchId,
  retryAt: Date,
): Promise<void> {
  await tx
    .update(waitlistMatches)
    .set({ availableAt: retryAt, leaseUntil: null })
    .where(and(eq(waitlistMatches.id, Id.parse(id)), eq(waitlistMatches.status, 'pending')));
}

// Candidates --------------------------------------------------------------------------------

/**
 * Entries that may be offered a slot with this staff member now: waiting (not offered
 * elsewhere), not expired, and for them or anyone.
 */
export async function listWaitingEntries(
  tx: TenantTx,
  now: Date,
  staffMemberId: StaffMemberId,
  limit: number,
): Promise<WaitlistEntryRow[]> {
  return tx
    .select()
    .from(waitlistEntries)
    .where(
      and(
        eq(waitlistEntries.status, 'waiting'),
        gt(waitlistEntries.expiresAt, now),
        or(
          isNull(waitlistEntries.staffMemberId),
          eq(waitlistEntries.staffMemberId, Id.parse(staffMemberId)),
        ),
      ),
    )
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
    .limit(Limit.parse(limit));
}

/** How many completed visits each client had (the ranking's last tie-breaker). */
export async function countCompletedVisits(
  tx: TenantTx,
  clientIds: readonly ClientId[],
): Promise<Map<string, number>> {
  if (clientIds.length === 0) return new Map();
  const rows = await tx
    .select({ clientId: bookings.clientId, visits: count() })
    .from(bookings)
    .where(
      and(
        inArray(
          bookings.clientId,
          clientIds.map((id) => Id.parse(id)),
        ),
        eq(bookings.status, 'completed'),
      ),
    )
    .groupBy(bookings.clientId);
  return new Map(rows.map((row) => [row.clientId, row.visits]));
}

/** Sets a waitlist entry's status (and booking, once an offer is claimed). */
export async function setWaitlistEntryStatus(
  tx: TenantTx,
  id: WaitlistEntryId,
  status: 'waiting' | 'offered' | 'booked',
  bookingId: BookingId | null = null,
): Promise<WaitlistEntryRow | undefined> {
  const [row] = await tx
    .update(waitlistEntries)
    .set({ status, bookingId: bookingId === null ? null : Id.parse(bookingId) })
    .where(eq(waitlistEntries.id, Id.parse(id)))
    .returning();
  return row;
}

// Offers ------------------------------------------------------------------------------------

export interface NewWaitlistOffer {
  matchId: WaitlistMatchId;
  entryId: WaitlistEntryId;
  clientId: ClientId;
  serviceId: ServiceId;
  staffMemberId: StaffMemberId;
  startsAt: Date;
  rank: number;
  tokenHash: string;
  expiresAt: Date;
}

export async function insertWaitlistOffer(
  tx: TenantTx,
  offer: NewWaitlistOffer,
): Promise<WaitlistOfferRow> {
  const [row] = await tx
    .insert(waitlistOffers)
    .values({
      matchId: Id.parse(offer.matchId),
      entryId: Id.parse(offer.entryId),
      clientId: Id.parse(offer.clientId),
      serviceId: Id.parse(offer.serviceId),
      staffMemberId: Id.parse(offer.staffMemberId),
      startsAt: offer.startsAt,
      rank: z.number().int().min(1).max(5).parse(offer.rank),
      tokenHash: TokenHashSchema.parse(offer.tokenHash),
      expiresAt: offer.expiresAt,
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** The offer behind a claim link (by its secret's hash), unlocked. */
export async function findWaitlistOfferByTokenHash(
  tx: TenantTx,
  tokenHash: string,
): Promise<WaitlistOfferRow | undefined> {
  const [row] = await tx
    .select()
    .from(waitlistOffers)
    .where(eq(waitlistOffers.tokenHash, TokenHashSchema.parse(tokenHash)));
  return row;
}

/** A match's offers, best first. */
export async function listOffersOfMatch(
  tx: TenantTx,
  matchId: WaitlistMatchId,
): Promise<WaitlistOfferRow[]> {
  return tx
    .select()
    .from(waitlistOffers)
    .where(eq(waitlistOffers.matchId, Id.parse(matchId)))
    .orderBy(asc(waitlistOffers.rank));
}

/** An entry's offers still open (the entry is being taken off the list). */
export async function listOpenOffersOfEntry(
  tx: TenantTx,
  entryId: WaitlistEntryId,
): Promise<WaitlistOfferRow[]> {
  return tx
    .select()
    .from(waitlistOffers)
    .where(
      and(eq(waitlistOffers.entryId, Id.parse(entryId)), eq(waitlistOffers.status, 'offered')),
    );
}

/** The offers still open for the time a booking freed (its cancellation is being undone). */
export async function listOpenOffersOfFreedBooking(
  tx: TenantTx,
  bookingId: BookingId,
): Promise<WaitlistOfferRow[]> {
  const rows = await tx
    .select({ offer: waitlistOffers })
    .from(waitlistOffers)
    .innerJoin(waitlistMatches, eq(waitlistMatches.id, waitlistOffers.matchId))
    .where(
      and(eq(waitlistMatches.bookingId, Id.parse(bookingId)), eq(waitlistOffers.status, 'offered')),
    );
  return rows.map((row) => row.offer);
}

/** Moves offers that are still `offered` to `status`; returns the ones it changed. */
export async function settleOpenOffers(
  tx: TenantTx,
  ids: readonly WaitlistOfferId[],
  status: Exclude<WaitlistOfferStatus, 'offered' | 'claimed'>,
): Promise<WaitlistOfferRow[]> {
  if (ids.length === 0) return [];
  return tx
    .update(waitlistOffers)
    .set({ status: WaitlistOfferStatusSchema.parse(status) })
    .where(
      and(
        inArray(
          waitlistOffers.id,
          ids.map((id) => Id.parse(id)),
        ),
        eq(waitlistOffers.status, 'offered'),
      ),
    )
    .returning();
}

/** The offer a client claimed: `claimed`, with the booking it made. */
export async function markOfferClaimed(
  tx: TenantTx,
  id: WaitlistOfferId,
  bookingId: BookingId,
): Promise<WaitlistOfferRow | undefined> {
  const [row] = await tx
    .update(waitlistOffers)
    .set({ status: 'claimed', bookingId: Id.parse(bookingId) })
    .where(and(eq(waitlistOffers.id, Id.parse(id)), eq(waitlistOffers.status, 'offered')))
    .returning();
  return row;
}

/** Open offers past their time in this business, at most `limit` (the clean-up pass). */
export async function listExpiredOpenOffers(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<WaitlistOfferRow[]> {
  return tx
    .select()
    .from(waitlistOffers)
    .where(and(eq(waitlistOffers.status, 'offered'), lte(waitlistOffers.expiresAt, now)))
    .orderBy(asc(waitlistOffers.expiresAt))
    .limit(Limit.parse(limit));
}

/** The latest offers, newest first (the waitlist screen); staff see their own only (RLS). */
export async function listRecentWaitlistOffers(
  tx: TenantTx,
  limit: number,
): Promise<WaitlistOfferRow[]> {
  return tx
    .select()
    .from(waitlistOffers)
    .orderBy(desc(waitlistOffers.createdAt), asc(waitlistOffers.rank))
    .limit(z.number().int().min(1).max(200).parse(limit));
}

/**
 * Closes this business's open offers past their time, at most `limit`: `expired`, and entries
 * left waiting on them wait again. Returns how many closed. The offer rows record the change;
 * the entries' audit records only what a person or a claim did.
 */
export async function expireWaitlistOffers(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<number> {
  const due = await listExpiredOpenOffers(tx, now, limit);
  if (due.length === 0) return 0;
  const closed = await tx
    .update(waitlistOffers)
    .set({ status: 'expired' })
    .where(
      and(
        inArray(
          waitlistOffers.id,
          due.map((offer) => offer.id),
        ),
        eq(waitlistOffers.status, 'offered'),
      ),
    )
    .returning({ entryId: waitlistOffers.entryId });
  if (closed.length > 0) {
    await tx
      .update(waitlistEntries)
      .set({ status: 'waiting' })
      .where(
        and(
          inArray(
            waitlistEntries.id,
            closed.map((offer) => offer.entryId),
          ),
          eq(waitlistEntries.status, 'offered'),
        ),
      );
  }
  return closed.length;
}

/** This business's freed times asked to be matched, oldest first. */
export async function listWaitlistMatches(
  tx: TenantTx,
  limit: number,
): Promise<WaitlistMatchRow[]> {
  return tx
    .select()
    .from(waitlistMatches)
    .orderBy(asc(waitlistMatches.createdAt), asc(waitlistMatches.id))
    .limit(Limit.parse(limit));
}

// The feed and the briefing (S38a, ADR-0042) ------------------------------------------------

// Written out in full: in a query on one table drizzle leaves a column's table off, which inside
// a subquery would name the subquery's own column.
const MATCH_ID = sql.raw('"waitlist_matches"."id"');

/** A freed time still ahead whose offers wait for an OK, went out, or were claimed. */
export interface ActiveWaitlistMatch {
  matchId: string;
  bookingId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  state: 'needs_ok' | 'offered' | 'claimed';
  offered: number;
}

/**
 * This business's freed times starting after `now` that the matcher offered or proposed: with
 * how many clients hold an open offer for each and whether one claimed it. Left out: a
 * proposal no longer pending with no offers made (turned down, expired), and offers that all
 * closed unclaimed (expired, taken back). Staff see their own only (RLS).
 */
export async function listActiveWaitlistMatches(
  tx: TenantTx,
  now: Date,
  limit = 100,
): Promise<ActiveWaitlistMatch[]> {
  const rows = await tx
    .select({
      matchId: waitlistMatches.id,
      bookingId: waitlistMatches.bookingId,
      staffMemberId: waitlistMatches.staffMemberId,
      startsAt: waitlistMatches.startsAt,
      endsAt: waitlistMatches.endsAt,
      // Offers still open or claimed: expired, taken back or "taken" ones no longer count.
      offered: sql<number>`(SELECT count(*)::int FROM waitlist_offers o WHERE o.match_id = ${MATCH_ID} AND o.status IN ('offered', 'claimed'))`,
      made: sql<number>`(SELECT count(*)::int FROM waitlist_offers o WHERE o.match_id = ${MATCH_ID})`,
      claimed: sql<boolean>`EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.match_id = ${MATCH_ID} AND o.status = 'claimed')`,
      pending: sql<boolean>`EXISTS (SELECT 1 FROM ai_action_proposals p WHERE p.idempotency_key = 'waitlist.' || ${MATCH_ID}::text AND p.status = 'pending' AND p.expires_at > ${now}::timestamptz)`,
    })
    .from(waitlistMatches)
    .where(
      and(
        eq(waitlistMatches.status, 'done'),
        inArray(waitlistMatches.outcome, ['offered', 'proposed']),
        gt(waitlistMatches.startsAt, now),
      ),
    )
    .orderBy(asc(waitlistMatches.startsAt), asc(waitlistMatches.id))
    .limit(Limit.parse(limit));
  return rows.flatMap((row) => {
    const state = row.claimed
      ? 'claimed'
      : row.offered > 0
        ? 'offered'
        : row.pending && row.made === 0
          ? 'needs_ok'
          : undefined;
    if (state === undefined) return [];
    return [
      {
        matchId: row.matchId,
        bookingId: row.bookingId,
        staffMemberId: row.staffMemberId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        state,
        offered: row.claimed ? row.made : row.offered,
      },
    ];
  });
}

/** The waitlist in numbers for the briefing: waiting now, and offers made and claimed since. */
export async function waitlistActivity(
  tx: TenantTx,
  now: Date,
  since: Date,
): Promise<{ waiting: number; offered: number; claimed: number }> {
  const [waiting] = await tx
    .select({ count: count() })
    .from(waitlistEntries)
    .where(
      and(
        inArray(waitlistEntries.status, ['waiting', 'offered']),
        gt(waitlistEntries.expiresAt, now),
      ),
    );
  const [offers] = await tx
    .select({
      offered: count(),
      claimed: sql<number>`count(*) FILTER (WHERE ${waitlistOffers.status} = 'claimed')::int`,
    })
    .from(waitlistOffers)
    .where(gt(waitlistOffers.createdAt, since));
  return {
    waiting: waiting?.count ?? 0,
    offered: offers?.offered ?? 0,
    claimed: offers?.claimed ?? 0,
  };
}
