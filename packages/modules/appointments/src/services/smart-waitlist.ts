import { createHash, randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  ClientIdSchema,
  offerExpiry,
  OfferTokenSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  WAITLIST_OFFER_LIMITS,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistOfferIdSchema,
  WaitlistOfferSchema,
  type BookingId,
  type ClientId,
  type OfferToken,
  type ServiceId,
  type StaffMemberId,
  type WaitlistEntryId,
  type WaitlistMatchId,
  type WaitlistOffer,
  type WaitlistOfferId,
} from '@pepper/contracts';
import { requirePermission, systemClock, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  countCompletedVisits,
  findClient,
  findCurrentTenant,
  findService,
  insertWaitlistMatch,
  insertWaitlistOffer,
  listOpenOffersOfEntry,
  listOpenOffersOfFreedBooking,
  listRecentWaitlistOffers,
  listWaitingEntries,
  lockWaitlistEntry,
  setWaitlistEntryStatus,
  settleOpenOffers,
  withMember,
  type BookingRow,
  type Database,
  type TenantTx,
  type WaitlistEntryRow,
  type WaitlistMatchRow,
  type WaitlistOfferRow,
} from '@pepper/db';
import { rankCandidates, windowsHold, type WaitlistFit } from '../bookings/waitlist-ranking.js';
import { waitlistAuditValues } from '../mapping.js';
import { serviceToBook, type TemplateRuleDefaultsOf } from './availability.js';
import { isBookable } from './bookings.js';
import { requestInsights } from './insights.js';

// The smart waitlist (S37, ADR-0041, AC-W5-1), the domain's half. A booking cancelled or moved
// away from a time asks, in its own transaction, for that time to be matched
// (`requestWaitlistMatch`); the worker then ranks who is waiting for it (`waitlistCandidatesIn`)
// and, through the trust layer, makes the offers (`makeWaitlistOffersIn`). Claiming is the
// booking page's (`claimWaitlistOffer`); offers past their time close in the clean-up pass.

const MINUTE_MS = 60_000;

/**
 * Asks for the time a booking held to be matched against the waitlist, in the transaction that
 * freed it (a cancellation, or a move away from it). A time already started is not offered.
 */
export async function requestWaitlistMatch(
  tx: TenantTx,
  freed: Pick<BookingRow, 'id' | 'staffMemberId' | 'startsAt' | 'endsAt'>,
  now: number,
): Promise<void> {
  if (freed.startsAt.getTime() <= now) return;
  await insertWaitlistMatch(tx, {
    bookingId: BookingIdSchema.parse(freed.id),
    staffMemberId: StaffMemberIdSchema.parse(freed.staffMemberId),
    startsAt: freed.startsAt,
    endsAt: freed.endsAt,
    // Due from the clock that freed it, not the database's: a business clock (tests, evals)
    // ahead of or behind the server's would otherwise hold the match back or run it early.
    availableAt: new Date(now),
  });
}

/** One entry the freed time may be offered to, with what *Why?* says about it. */
export interface WaitlistCandidateView {
  entryId: WaitlistEntryId;
  clientId: ClientId;
  serviceId: ServiceId;
  rank: number;
  fit: WaitlistFit;
  /** When they joined the list (UTC). */
  waitingSince: string;
  visits: number;
}

export interface CandidateOptions {
  now: Date;
  fanOut: number;
  templateRuleDefaults?: TemplateRuleDefaultsOf | undefined;
}

/**
 * The best entries to offer a freed time to, best first (the published ranking): waiting,
 * not expired, for this staff member or anyone, with a window that holds the whole
 * appointment of their service, a client with an email address, and that service bookable with this staff member at exactly
 * that time now (hours, rules, notice, buffers, other bookings: the availability engine). A
 * time partly re-booked meanwhile fits no one.
 */
export async function waitlistCandidatesIn(
  tx: TenantTx,
  match: Pick<WaitlistMatchRow, 'staffMemberId' | 'startsAt'>,
  options: CandidateOptions,
): Promise<WaitlistCandidateView[]> {
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('No tenant in this transaction');
  const staffMemberId = StaffMemberIdSchema.parse(match.staffMemberId);
  const start = match.startsAt.getTime();
  const now = options.now.getTime();
  const entries = await listWaitingEntries(
    tx,
    options.now,
    staffMemberId,
    WAITLIST_OFFER_LIMITS.maxCandidates,
  );
  const services = new Map<string, Awaited<ReturnType<typeof findService>>>();
  // The staff member and the time are fixed, so whether a service fits is asked once.
  const fits = new Map<string, boolean>();
  const fitting: WaitlistEntryRow[] = [];
  for (const entry of entries) {
    if (!services.has(entry.serviceId)) {
      services.set(entry.serviceId, await findService(tx, ServiceIdSchema.parse(entry.serviceId)));
    }
    const service = services.get(entry.serviceId);
    if (!service?.active) continue;
    const windows = WaitlistEntryInputSchema.shape.windows.parse(entry.windows);
    if (!windowsHold(windows, tenant.timeZone, start, service.durationMinutes)) continue;
    // Offers go by email (V1): a client without an address can't be offered one.
    const client = await findClient(tx, ClientIdSchema.parse(entry.clientId));
    if (client === undefined || client.email === null) continue;
    if (!fits.has(service.id)) {
      fits.set(
        service.id,
        await isBookable(tx, {
          service: serviceToBook(service),
          staffMemberId,
          start,
          now,
          templateRuleDefaults: options.templateRuleDefaults,
        }),
      );
    }
    if (fits.get(service.id) === true) fitting.push(entry);
  }
  const visits = await countCompletedVisits(
    tx,
    fitting.map((entry) => ClientIdSchema.parse(entry.clientId)),
  );
  const fanOut = Math.min(Math.max(1, options.fanOut), WAITLIST_OFFER_LIMITS.maxFanOut);
  return rankCandidates(
    fitting.map((entry) => ({
      entryId: entry.id,
      staffMemberId: entry.staffMemberId,
      createdAt: entry.createdAt,
      visits: visits.get(entry.clientId) ?? 0,
      entry,
    })),
    staffMemberId,
    fanOut,
  ).map(({ candidate, fit, rank }) => ({
    entryId: WaitlistEntryIdSchema.parse(candidate.entry.id),
    clientId: ClientIdSchema.parse(candidate.entry.clientId),
    serviceId: ServiceIdSchema.parse(candidate.entry.serviceId),
    rank,
    fit,
    waitingSince: candidate.entry.createdAt.toISOString(),
    visits: candidate.visits,
  }));
}

/** Whether a freed time can still be offered at `now`: its offers would stay open long enough. */
export function stillOfferable(startsAt: Date, now: Date): boolean {
  const closes = offerExpiry(now.getTime(), startsAt.getTime());
  return closes - now.getTime() >= WAITLIST_OFFER_LIMITS.minClaimMinutes * MINUTE_MS;
}

/** A new claim link's secret and the hash that is stored. */
export function newOfferToken(): { token: OfferToken; hash: string } {
  const token = OfferTokenSchema.parse(randomBytes(32).toString('base64url'));
  return { token, hash: offerTokenHash(token) };
}

/** SHA-256 (hex) of a claim link's secret: 256 random bits need no key or slow hash. */
export function offerTokenHash(token: OfferToken): string {
  return createHash('sha256').update(OfferTokenSchema.parse(token)).digest('hex');
}

export interface MadeOffer {
  offer: WaitlistOfferRow;
  /** The claim link's secret: only the email gets it. */
  token: OfferToken;
}

/**
 * Offers a freed time to the entries given (the ranking's best, each checked again here: still
 * waiting and the time still bookable for their service), in the caller's transaction: one
 * offer each with its own claim link, the entries marked `offered`. Returns the offers made,
 * best first; none when the time can no longer be offered.
 */
export async function makeWaitlistOffersIn(
  tx: TenantTx,
  actor: Actor,
  input: {
    matchId: WaitlistMatchId;
    staffMemberId: StaffMemberId;
    startsAt: Date;
    entries: readonly { entryId: WaitlistEntryId; rank: number }[];
  },
  options: { now: Date; templateRuleDefaults?: TemplateRuleDefaultsOf | undefined },
): Promise<MadeOffer[]> {
  requirePermission(actor, 'bookings.manage', { ownerUserId: null });
  if (!stillOfferable(input.startsAt, options.now)) return [];
  const expiresAt = new Date(offerExpiry(options.now.getTime(), input.startsAt.getTime()));
  const made: MadeOffer[] = [];
  for (const { entryId, rank } of [...input.entries].sort((a, b) => a.rank - b.rank)) {
    const entry = await lockWaitlistEntry(tx, entryId);
    if (entry?.status !== 'waiting' || entry.expiresAt <= options.now) continue;
    if (entry.staffMemberId !== null && entry.staffMemberId !== input.staffMemberId) continue;
    const service = await findService(tx, ServiceIdSchema.parse(entry.serviceId));
    if (!service?.active) continue;
    const bookable = await isBookable(tx, {
      service: serviceToBook(service),
      staffMemberId: input.staffMemberId,
      start: input.startsAt.getTime(),
      now: options.now.getTime(),
      templateRuleDefaults: options.templateRuleDefaults,
    });
    if (!bookable) continue;
    const { token, hash } = newOfferToken();
    const offer = await insertWaitlistOffer(tx, {
      matchId: input.matchId,
      entryId,
      clientId: ClientIdSchema.parse(entry.clientId),
      serviceId: ServiceIdSchema.parse(entry.serviceId),
      staffMemberId: input.staffMemberId,
      startsAt: input.startsAt,
      rank,
      tokenHash: hash,
      expiresAt,
      offeredAt: options.now,
    });
    await changeEntryStatus(tx, entry, 'offered');
    made.push({ offer, token });
  }
  // The feed's `waitlist_match` item shows the offers within about a minute (S38a).
  if (made.length > 0) await requestInsights(tx);
  return made;
}

/**
 * Takes offers back (Undo before their emails left): the offers close as `expired` and their
 * entries wait again. Offers already claimed stay as they are.
 */
export async function takeBackWaitlistOffersIn(
  tx: TenantTx,
  offerIds: readonly WaitlistOfferId[],
): Promise<number> {
  const closed = await settleOpenOffers(tx, offerIds, 'expired');
  for (const offer of closed) await releaseEntry(tx, offer);
  return closed.length;
}

/** Closes an entry's open offers (the entry is taken off the list): its links read as expired. */
export async function withdrawOffersOfEntry(
  tx: TenantTx,
  entryId: WaitlistEntryId,
): Promise<number> {
  const open = await listOpenOffersOfEntry(tx, entryId);
  return takeBackWaitlistOffersIn(
    tx,
    open.map((offer) => WaitlistOfferIdSchema.parse(offer.id)),
  );
}

/**
 * Closes the open offers for the time a booking freed, when the booking comes back (its
 * cancellation undone): the time was never really free, so its links read as expired and the
 * entries wait again.
 */
export async function withdrawOffersOfFreedBooking(
  tx: TenantTx,
  bookingId: BookingId,
): Promise<number> {
  const open = await listOpenOffersOfFreedBooking(tx, bookingId);
  return takeBackWaitlistOffersIn(
    tx,
    open.map((offer) => WaitlistOfferIdSchema.parse(offer.id)),
  );
}

/** The latest offers for the waitlist screen; staff see their own staff member's only. */
export async function listWaitlistOffers(
  db: Database,
  actor: Actor,
  options: { clock?: Clock; limit?: number } = {},
): Promise<WaitlistOffer[]> {
  requirePermission(actor, 'bookings.read');
  const now = (options.clock ?? systemClock).now();
  const rows = await withMember(db, actor.context, (tx) =>
    listRecentWaitlistOffers(tx, options.limit ?? 50),
  );
  return rows.map((row) => toWaitlistOffer(row, now));
}

/** An offer as the team sees it; one past its time reads as expired before the pass runs. */
export function toWaitlistOffer(row: WaitlistOfferRow, now: Date): WaitlistOffer {
  const status = row.status === 'offered' && row.expiresAt <= now ? 'expired' : row.status;
  return WaitlistOfferSchema.parse({
    id: row.id,
    entryId: row.entryId,
    clientId: row.clientId,
    staffMemberId: row.staffMemberId,
    startsAt: row.startsAt.toISOString(),
    status,
    expiresAt: row.expiresAt.toISOString(),
    rank: row.rank,
    createdAt: row.createdAt.toISOString(),
  });
}

/** An entry whose offer closed unclaimed waits again (if it was still waiting on that offer). */
export async function releaseEntry(
  tx: TenantTx,
  offer: Pick<WaitlistOfferRow, 'entryId'>,
): Promise<void> {
  const entry = await lockWaitlistEntry(tx, WaitlistEntryIdSchema.parse(offer.entryId));
  if (entry?.status === 'offered') await changeEntryStatus(tx, entry, 'waiting');
}

/** Sets an entry's status and audits it (as the system: the business's waitlist did it). */
export async function changeEntryStatus(
  tx: TenantTx,
  entry: WaitlistEntryRow,
  status: 'waiting' | 'offered' | 'booked',
  bookingId: string | null = null,
): Promise<WaitlistEntryRow> {
  const updated = await setWaitlistEntryStatus(
    tx,
    WaitlistEntryIdSchema.parse(entry.id),
    status,
    bookingId === null ? null : BookingIdSchema.parse(bookingId),
  );
  // The caller holds the row lock.
  if (updated === undefined) throw new Error('The waitlist entry is gone');
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'waitlist_entry.updated',
      entity: { type: 'waitlist_entry', id: entry.id },
      before: waitlistAuditValues(entry),
      after: waitlistAuditValues(updated),
    },
  });
  return updated;
}
