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

/** Entries that may be offered a slot now: waiting (not offered elsewhere) and not expired. */
export async function listWaitingEntries(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<WaitlistEntryRow[]> {
  return tx
    .select()
    .from(waitlistEntries)
    .where(and(eq(waitlistEntries.status, 'waiting'), gt(waitlistEntries.expiresAt, now)))
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
