import {
  BookingIdSchema,
  BookingStatusSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  WIN_BACK_LIMITS,
  WinBackResponseSchema,
  type WinBackResponse,
} from '@pepper/contracts';
import {
  ForbiddenError,
  permissionScope,
  requirePermission,
  systemClock,
  type Actor,
  type Clock,
} from '@pepper/core';
import {
  findCurrentTenant,
  listInsightBookings,
  listServices,
  listStaffMembers,
  readWinBackClients,
  REGULAR_OFFER_QUIET_DAYS,
  type TenantTx,
} from '@pepper/db';
import { INSIGHT_HISTORY_DAYS } from '../insights/types.js';
import { findWinBack, type WinBackClient } from '../insights/win-back.js';

// "Haven't been back" (S54.2, ADR-0057; AC-W4-6, AC-W4-8): the win-back rule over the
// business's bookings, read when asked, with each client's reach and value. Owners and
// managers only (they decide the nudges; the list names every client of the business).

const DAY_MS = 86_400_000;

/** A found client with what the list and the draft need. */
export interface WinBackEntry extends WinBackClient {
  name: string;
  hasEmail: boolean;
  optedOut: boolean;
  pendingProposalId: string | null;
  emailedAt: Date | null;
  valueCents: number | null;
  /** Their last service can be booked (an imported visit's hidden service can't). */
  serviceBookable: boolean;
}

/** Owners and managers: a role that reaches every booking and client. */
export function requireWinBackAccess(actor: Actor): void {
  requirePermission(actor, 'clients.read');
  if (permissionScope(actor.context.role, 'bookings.manage') !== 'all') {
    throw new ForbiddenError('bookings.manage');
  }
}

/** The quiet windows a new marketing email waits out, from `now`. */
export function winBackQuiet(now: Date): { now: Date; nudgeSince: Date; offerSince: Date } {
  return {
    now,
    nudgeSince: new Date(now.getTime() - WIN_BACK_LIMITS.quietDays * DAY_MS),
    offerSince: new Date(now.getTime() - REGULAR_OFFER_QUIET_DAYS * DAY_MS),
  };
}

/** Every client who hasn't been back, in the rule's order, with reach and value. */
export async function findWinBackEntries(
  tx: TenantTx,
  actor: Actor,
  now: Date,
): Promise<WinBackEntry[]> {
  return (await loadWinBack(tx, actor, now)).entries;
}

async function loadWinBack(tx: TenantTx, actor: Actor, now: Date) {
  requireWinBackAccess(actor);
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('No business in this transaction');
  const [serviceRows, bookingRows] = [
    await listServices(tx),
    await listInsightBookings(tx, new Date(now.getTime() - INSIGHT_HISTORY_DAYS * DAY_MS)),
  ];
  const found = findWinBack({
    now: now.getTime(),
    timeZone: tenant.timeZone,
    services: serviceRows.map((row) => ({
      id: ServiceIdSchema.parse(row.id),
      rebookAfterDays: row.rebookAfterDays,
    })),
    bookings: bookingRows.map((row) => ({
      id: BookingIdSchema.parse(row.id),
      clientId: ClientIdSchema.parse(row.clientId),
      serviceId: ServiceIdSchema.parse(row.serviceId),
      staffMemberId: StaffMemberIdSchema.parse(row.staffMemberId),
      start: row.startsAt.getTime(),
      end: row.endsAt.getTime(),
      bufferBeforeMinutes: row.bufferBeforeMinutes,
      bufferAfterMinutes: row.bufferAfterMinutes,
      status: BookingStatusSchema.parse(row.status),
    })),
  });
  const clients = new Map(
    (
      await readWinBackClients(
        tx,
        found.map((each) => each.clientId),
        winBackQuiet(now),
      )
    ).map((row) => [row.id, row]),
  );
  // The value is the last service's own price, as the feed prices a regular who is due (S52);
  // else what the last visit cost (an imported visit's service is hidden and has no price).
  const prices = new Map(serviceRows.map((row) => [row.id, row.priceFromCents]));
  const paid = new Map(bookingRows.map((row) => [row.id, row.priceFromCents]));
  const active = new Map(serviceRows.map((row) => [row.id, row.active]));
  const entries = found.flatMap((each): WinBackEntry[] => {
    const client = clients.get(each.clientId);
    if (client === undefined) return [];
    return [
      {
        ...each,
        name: client.name,
        hasEmail: client.hasEmail,
        optedOut: client.optedOut,
        pendingProposalId: client.pendingProposalId,
        emailedAt: client.emailedAt,
        valueCents: prices.get(each.serviceId) ?? paid.get(each.lastBookingId) ?? null,
        serviceBookable: active.get(each.serviceId) === true,
      },
    ];
  });
  return { tenant, serviceRows, entries };
}

/** `GET /v1/win-back`: the list (its first rows), the count and the sum of every client. */
export async function listWinBackIn(
  tx: TenantTx,
  actor: Actor,
  options: { clock?: Clock } = {},
): Promise<WinBackResponse> {
  const now = (options.clock ?? systemClock).now();
  const { tenant, serviceRows, entries } = await loadWinBack(tx, actor, now);
  const staff = new Map((await listStaffMembers(tx)).map((row) => [row.id, row.displayName]));
  const services = new Map(serviceRows.map((row) => [row.id, row.name]));
  const rows = entries.slice(0, WIN_BACK_LIMITS.listMax).map((entry) => ({
    clientId: entry.clientId,
    name: entry.name,
    lastVisitAt: new Date(entry.lastVisitAt).toISOString(),
    serviceName: services.get(entry.serviceId) ?? null,
    staffName: staff.get(entry.staffMemberId) ?? null,
    valueCents: entry.valueCents,
    visits: entry.visits,
    daysOverdue: entry.daysOverdue,
    reach: entry.optedOut ? 'opted_out' : entry.hasEmail ? 'email' : 'no_email',
    serviceBookable: entry.serviceBookable,
    pendingProposalId: entry.pendingProposalId,
    emailedAt: entry.emailedAt?.toISOString() ?? null,
  }));
  return WinBackResponseSchema.parse({
    clients: rows,
    count: entries.length,
    totalCents: entries.reduce((sum, entry) => sum + (entry.valueCents ?? 0), 0),
    mailingAddressSet: tenant.mailingAddress !== null,
  });
}
