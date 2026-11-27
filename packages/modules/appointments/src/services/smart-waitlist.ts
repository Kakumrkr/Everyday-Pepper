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
  WaitlistMatchIdSchema,
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
  findBooking,
  findClient,
  findCurrentTenant,
  findService,
  findWaitlistMatchOfFreedBooking,
  insertWaitlistMatch,
  insertWaitlistOffer,
  listOpenOffersOfEntry,
  listOffersOfMatch,
  listOpenOffersOfFreedBooking,
  listRecentWaitlistOffers,
  listRegularCandidates,
  listWaitingEntries,
  lockWaitlistEntry,
  readInsightTenant,
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

/**
 * One client the freed time may be offered to, with what *Why?* says about them: someone on
 * the waitlist (`source` 'waitlist', their entry) or an overdue regular of that staff member
 * (`source` 'regular', no entry; S54, ADR-0056).
 */
export type WaitlistCandidateView =
  | {
      source: 'waitlist';
      entryId: WaitlistEntryId;
      clientId: ClientId;
      serviceId: ServiceId;
      rank: number;
      fit: WaitlistFit;
      /** When they joined the list (UTC). */
      waitingSince: string;
      visits: number;
    }
  | {
      source: 'regular';
      entryId: null;
      clientId: ClientId;
      serviceId: ServiceId;
      rank: number;
      fit: 'regular';
      /** The local day they were due back (YYYY-MM-DD). */
      dueOn: string;
      intervalDays: number | null;
      visits: number;
    };

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
  match: Pick<WaitlistMatchRow, 'staffMemberId' | 'startsAt' | 'bookingId'>,
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
  const waiting: WaitlistCandidateView[] = [];
  const offeredClients = new Set<string>();
  for (const { candidate, fit } of rankCandidates(
    fitting.map((entry) => ({
      entryId: entry.id,
      staffMemberId: entry.staffMemberId,
      createdAt: entry.createdAt,
      visits: visits.get(entry.clientId) ?? 0,
      entry,
    })),
    staffMemberId,
    WAITLIST_OFFER_LIMITS.maxFanOut,
  )) {
    // One offer per client: a second entry of theirs is not a second chance at the same time.
    if (waiting.length >= fanOut || offeredClients.has(candidate.entry.clientId)) continue;
    offeredClients.add(candidate.entry.clientId);
    waiting.push({
      source: 'waitlist',
      entryId: WaitlistEntryIdSchema.parse(candidate.entry.id),
      clientId: ClientIdSchema.parse(candidate.entry.clientId),
      serviceId: ServiceIdSchema.parse(candidate.entry.serviceId),
      rank: waiting.length + 1,
      fit,
      waitingSince: candidate.entry.createdAt.toISOString(),
      visits: candidate.visits,
    });
  }
  if (waiting.length >= fanOut) return waiting;
  const regulars = await regularCandidatesIn(tx, {
    staffMemberId,
    start,
    now: options.now,
    freedBookingId: BookingIdSchema.parse(match.bookingId),
    exceptClientIds: [...offeredClients].map((id) => ClientIdSchema.parse(id)),
    limit: fanOut - waiting.length,
    templateRuleDefaults: options.templateRuleDefaults,
  });
  return [
    ...waiting,
    ...regulars.map((regular, index) => ({ ...regular, rank: waiting.length + index + 1 })),
  ];
}

/** How many of a staff member's due regulars are read for one freed time, at most. */
const MAX_REGULARS_READ = 50;

/**
 * Overdue regulars of the freed time's staff member who may be offered it (S54, ADR-0056,
 * AC-W5-3), most overdue first: the feed's open `rebooking_due` suggestions for that staff
 * member (the insights pass's rule: past their usual interval, nothing booked) whose client can
 * be emailed and wasn't offered a time in the last 7 days (`listRegularCandidates`), never the
 * client who freed it, and whose last service is bookable with that staff member at exactly
 * that time. Ranks start at 1; the caller puts them after the waitlist.
 */
export async function regularCandidatesIn(
  tx: TenantTx,
  input: {
    staffMemberId: StaffMemberId;
    start: number;
    now: Date;
    freedBookingId: BookingId | null;
    exceptClientIds: readonly ClientId[];
    limit: number;
    /** Only these clients (checking chosen ones again before the offer). */
    onlyClientIds?: readonly ClientId[];
    templateRuleDefaults?: TemplateRuleDefaultsOf | undefined;
  },
): Promise<Extract<WaitlistCandidateView, { source: 'regular' }>[]> {
  if (input.limit <= 0) return [];
  // An unasked offer is marketing email: without the business's mailing address for its
  // footer (as a rebooking nudge, ADR-0040), no regular is offered anything.
  const tenant = await readInsightTenant(tx);
  if (tenant === undefined || tenant.mailingAddress === null) return [];
  // Suggestions paused, or "regulars who are due" turned off: the owner asked for quiet.
  if (
    tenant.settings.suggestionsPaused ||
    tenant.settings.disabledKinds.includes('rebooking_due')
  ) {
    return [];
  }
  const freed =
    input.freedBookingId === null ? undefined : await findBooking(tx, input.freedBookingId);
  const except = [...input.exceptClientIds];
  // Whoever gave the time up isn't offered it back.
  if (freed !== undefined) except.push(ClientIdSchema.parse(freed.clientId));
  const rows = await listRegularCandidates(tx, {
    staffMemberId: input.staffMemberId,
    now: input.now,
    exceptClientIds: except,
    ...(input.onlyClientIds !== undefined && { onlyClientIds: input.onlyClientIds }),
    limit: MAX_REGULARS_READ,
  });
  const fits = new Map<string, boolean>();
  const seen = new Set<string>();
  const chosen: Extract<WaitlistCandidateView, { source: 'regular' }>[] = [];
  // Already in the published order (most overdue, most visits, id).
  for (const row of rows) {
    if (chosen.length >= input.limit) break;
    if (seen.has(row.clientId)) continue;
    seen.add(row.clientId);
    if (!fits.has(row.serviceId)) {
      const service = await findService(tx, ServiceIdSchema.parse(row.serviceId));
      fits.set(
        row.serviceId,
        service?.active === true &&
          (await isBookable(tx, {
            service: serviceToBook(service),
            staffMemberId: input.staffMemberId,
            start: input.start,
            now: input.now.getTime(),
            templateRuleDefaults: input.templateRuleDefaults,
          })),
      );
    }
    if (fits.get(row.serviceId) !== true) continue;
    chosen.push({
      source: 'regular',
      entryId: null,
      clientId: ClientIdSchema.parse(row.clientId),
      serviceId: ServiceIdSchema.parse(row.serviceId),
      rank: chosen.length + 1,
      fit: 'regular',
      dueOn: row.dueOn,
      intervalDays: row.intervalDays,
      visits: row.visits,
    });
  }
  return chosen;
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

/** Who an offer goes to: a waitlist entry, or a regular (no entry) with their service. */
export type OfferTarget =
  | { entryId: WaitlistEntryId; rank: number }
  | { entryId: null; clientId: ClientId; serviceId: ServiceId; rank: number };

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
    /** The freed booking: its client is never offered the time back (regulars, S54). */
    freedBookingId?: BookingId | null;
    entries: readonly OfferTarget[];
  },
  options: { now: Date; templateRuleDefaults?: TemplateRuleDefaultsOf | undefined },
): Promise<MadeOffer[]> {
  requirePermission(actor, 'bookings.manage', { ownerUserId: null });
  if (!stillOfferable(input.startsAt, options.now)) return [];
  const expiresAt = new Date(offerExpiry(options.now.getTime(), input.startsAt.getTime()));
  const made: MadeOffer[] = [];
  const offeredClients = new Set<string>();
  for (const target of [...input.entries].sort((a, b) => a.rank - b.rank)) {
    let clientId: ClientId;
    let serviceId: ServiceId;
    let entry: WaitlistEntryRow | undefined;
    if (target.entryId === null) {
      // A regular (S54): every rule checked again now (an address, not opted out, nothing
      // booked meanwhile, no other offer this week, still due), or no offer.
      const [still] = await regularCandidatesIn(tx, {
        staffMemberId: input.staffMemberId,
        start: input.startsAt.getTime(),
        now: options.now,
        freedBookingId: input.freedBookingId ?? null,
        exceptClientIds: [...offeredClients].map((id) => ClientIdSchema.parse(id)),
        onlyClientIds: [target.clientId],
        limit: 1,
        templateRuleDefaults: options.templateRuleDefaults,
      });
      if (still?.serviceId !== target.serviceId) continue;
      clientId = still.clientId;
      serviceId = still.serviceId;
    } else {
      entry = await lockWaitlistEntry(tx, target.entryId);
      if (entry?.status !== 'waiting' || entry.expiresAt <= options.now) continue;
      if (entry.staffMemberId !== null && entry.staffMemberId !== input.staffMemberId) continue;
      if (offeredClients.has(entry.clientId)) continue;
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
      clientId = ClientIdSchema.parse(entry.clientId);
      serviceId = ServiceIdSchema.parse(entry.serviceId);
    }
    const { token, hash } = newOfferToken();
    const offer = await insertWaitlistOffer(tx, {
      matchId: input.matchId,
      entryId: target.entryId,
      clientId,
      serviceId,
      staffMemberId: input.staffMemberId,
      startsAt: input.startsAt,
      rank: target.rank,
      tokenHash: hash,
      expiresAt,
      offeredAt: options.now,
    });
    if (entry !== undefined) await changeEntryStatus(tx, entry, 'offered');
    offeredClients.add(clientId);
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

/**
 * What came of a freed time's offers (S54, AC-W5-5), for the offer's line on Activity:
 * `filled` (a client claimed it: who, and the booking's price), `open` (an offer can still be
 * claimed), or `unclaimed` (every offer closed). `undefined` when the viewer can't see the
 * time's offers (staff see their own staff member's only) or none were made.
 */
export interface WaitlistFill {
  state: 'open' | 'filled' | 'unclaimed';
  /** The client who claimed it (their full name; the caller shortens it). */
  clientName: string | null;
  /** The booking's listed price in cents; `null` without one. */
  priceCents: number | null;
  /** How many clients the time was offered to (S78.2). */
  offered: number;
}

export async function waitlistFillOf(
  db: Database,
  actor: Actor,
  matchId: WaitlistMatchId,
  options: { clock?: Clock } = {},
): Promise<WaitlistFill | undefined> {
  requirePermission(actor, 'bookings.read');
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    const offers = await listOffersOfMatch(tx, matchId);
    if (offers.length === 0) return undefined;
    const claimed = offers.find((offer) => offer.status === 'claimed');
    if (claimed !== undefined && claimed.bookingId !== null) {
      const booking = await findBooking(tx, BookingIdSchema.parse(claimed.bookingId));
      const client = await findClient(tx, ClientIdSchema.parse(claimed.clientId));
      return {
        state: 'filled',
        // A client deleted since isn't named.
        clientName: client?.deletedAt === null ? client.name : null,
        priceCents: booking?.priceFromCents ?? null,
        offered: offers.length,
      };
    }
    const open = offers.some((offer) => offer.status === 'offered' && offer.expiresAt > now);
    return {
      state: open ? 'open' : 'unclaimed',
      clientName: null,
      priceCents: null,
      offered: offers.length,
    };
  });
}

/**
 * What the fill loop made of a released visit's time (S78.2, AC-X-211), for its Activity line:
 * the match of the time the booking freed, read as `waitlistFillOf`; `undefined` before any
 * offer (or when the viewer can't see them).
 */
export async function releasedFillOf(
  db: Database,
  actor: Actor,
  bookingId: BookingId,
  options: { clock?: Clock } = {},
): Promise<WaitlistFill | undefined> {
  requirePermission(actor, 'bookings.read');
  const match = await withMember(db, actor.context, (tx) =>
    findWaitlistMatchOfFreedBooking(tx, BookingIdSchema.parse(bookingId)),
  );
  if (match === undefined) return undefined;
  return waitlistFillOf(db, actor, WaitlistMatchIdSchema.parse(match.id), options);
}

/** An offer as the team sees it; one past its time reads as expired before the pass runs. */
export function toWaitlistOffer(row: WaitlistOfferRow, now: Date): WaitlistOffer {
  const status = row.status === 'offered' && row.expiresAt <= now ? 'expired' : row.status;
  return WaitlistOfferSchema.parse({
    id: row.id,
    entryId: row.entryId,
    source: row.source,
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
  // A regular's offer has no entry (S54).
  if (offer.entryId === null) return;
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
