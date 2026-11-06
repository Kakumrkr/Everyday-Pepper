import {
  ALTERNATIVE_SLOT_COUNT,
  BookingChangeSchema,
  BookingIdSchema,
  BookingInputSchema,
  BookingsQuerySchema,
  WalkInBookingInputSchema,
  BookingStatusSchema,
  BusyQuerySchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  canChangeStatus,
  statusNeedsStart,
  type AvailableSlot,
  type Booking,
  type BookingChange,
  type BookingId,
  type BookingInput,
  type BookingsQuery,
  type BookingSource,
  type BusyQuery,
  type BusyTime,
  type ClientContact,
  type ClientId,
  type StaffMemberId,
  type WalkInBookingInput,
  type WalkInClient,
} from '@pepper/contracts';
import {
  auditActorOf,
  ClientNotFoundError,
  ForbiddenError,
  permissionScope,
  requirePermission,
  systemClock,
  walkInClientIn,
  type Actor,
  type Clock,
} from '@pepper/core';
import {
  appendAuditEntry,
  BookingIdempotencyKeyTakenError,
  BookingOverlapError,
  findBooking,
  findBookingByIdempotencyKey,
  findCurrentTenant,
  findService,
  findStaffMemberOfUser,
  insertBooking,
  findClient,
  listBookings as listBookingRows,
  listClientBookings,
  listOccupancy,
  lockBooking,
  lockStaffMember,
  moveBooking,
  setBookingManageTokenHash,
  setBookingStatus,
  withMember,
  type BookingRow,
  type Database,
  type StaffMemberRecord,
  type TenantTx,
} from '@pepper/db';
import type { ServiceToBook } from '../availability/engine.js';
import { alternativesRange, nearestSlots, toAvailableSlot } from '../bookings/planning.js';
import {
  BookingAlreadyStartedError,
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingNotStartedError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
} from '../errors.js';
import { bookingAuditValues, sameValues, staffOwner, toBooking, toBusyTime } from '../mapping.js';
import { noteFirstBookingIn } from './activation.js';
import { serviceToBook, slotsFor, type TemplateRuleDefaultsOf } from './availability.js';
import { findClientToBook } from './clients.js';
import { changeOf, emailDetailsOf, newManageToken, type BookingNotify } from './notices.js';
import { requestInsights } from './insights.js';
import { keepReminderInStep } from './reminders.js';
import { requestWaitlistMatch, withdrawOffersOfFreedBooking } from './smart-waitlist.js';

// Bookings (ADR-0017). `bookings.manage` lets owners and managers book anyone and staff only
// their own staff member (AC-W9-1); the database's member scope enforces the same, so staff
// never even see other staff members' bookings. A booking must fit the availability engine
// (hours, time off, rules, other bookings), except that owners and managers may override hours
// and rules; the exclusion constraint refuses overlaps in every case, also under races. The
// staff member is locked while a booking is checked and written, so their daily cap holds
// under concurrency too.

const MINUTE_MS = 60_000;

export interface CreateBookingOptions {
  clock?: Clock;
  source?: BookingSource;
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** Told about the new booking inside its transaction, when `notifyClient` (ADR-0025). */
  notify?: BookingNotify;
}

/** Books a client. `SlotUnavailableError` (with alternatives) when the time is not free. */
export async function createBooking(
  db: Database,
  actor: Actor,
  input: BookingInput,
  options: CreateBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const request = BookingInputSchema.parse(input);
  if (request.override) requireOverride(actor);
  return withMember(db, actor.context, (tx) => createBookingIn(tx, actor, request, options));
}

/**
 * `createBooking` inside the caller's transaction (ADR-0028 §9: the AI's tools run in the trust
 * layer's). The write runs in a savepoint, so a refused time leaves the transaction usable and
 * the nearest alternatives are read in it; nothing is committed here.
 */
export async function createBookingIn(
  tx: TenantTx,
  actor: Actor,
  input: BookingInput,
  options: CreateBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const { clientId, clientContact, ...slot } = BookingInputSchema.parse(input);
  return bookIn(tx, actor, slot, { kind: 'existing', clientId, contact: clientContact }, options);
}

/**
 * Books a walk-in (S50.2, ADR-0052): the new client and their booking together or not at all.
 * Staff book for themselves, as any booking; a client with the walk-in's email (or, without
 * one, the one client with their phone) is booked instead of adding a second.
 * `SlotUnavailableError` (with alternatives) when the time is not free: no client is added.
 */
export async function createWalkInBooking(
  db: Database,
  actor: Actor,
  input: WalkInBookingInput,
  options: CreateBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const { client, ...slot } = WalkInBookingInputSchema.parse(input);
  return withMember(db, actor.context, (tx) =>
    bookIn(tx, actor, slot, { kind: 'walk_in', client }, options),
  );
}

/** Whom a booking is for: a client the member may book, or a walk-in to add with it. */
type ClientToBook =
  | { kind: 'existing'; clientId: ClientId; contact: ClientContact | undefined }
  | { kind: 'walk_in'; client: WalkInClient };

type SlotRequest = Omit<ReturnType<typeof BookingInputSchema.parse>, 'clientId' | 'clientContact'>;

async function bookIn(
  tx: TenantTx,
  actor: Actor,
  request: SlotRequest,
  who: ClientToBook,
  options: CreateBookingOptions,
): Promise<Booking> {
  if (request.override) requireOverride(actor);
  const now = (options.clock ?? systemClock).now().getTime();
  const start = Date.parse(request.startsAt);
  const key = request.idempotencyKey ?? null;
  const { templateRuleDefaults } = options;
  // A walk-in's retry with the key names the same time, not the client its first try added.
  const sameRequest = (row: BookingRow) =>
    (who.kind === 'walk_in' || row.clientId === who.clientId) &&
    row.serviceId === request.serviceId &&
    row.staffMemberId === request.staffMemberId &&
    row.startsAt.getTime() === start;
  const retried = async (): Promise<Booking | undefined> => {
    if (key === null) return undefined;
    const existing = await findBookingByIdempotencyKey(tx, key);
    if (existing === undefined) return undefined;
    if (!sameRequest(existing)) throw new IdempotencyKeyReusedError();
    return toBooking(existing);
  };

  const staff = await lockStaff(tx, actor, request.staffMemberId);
  // After the lock: a concurrent first attempt with the key (same staff member) has committed
  // by now, so a retry returns its booking instead of finding the time taken.
  const earlier = await retried();
  if (earlier !== undefined) return earlier;
  const serviceRow = await findService(tx, request.serviceId);
  if (serviceRow === undefined) throw new ServiceNotFoundError();
  const service = serviceToBook(serviceRow);
  if (who.kind === 'existing') await findClientToBook(tx, who.clientId, who.contact);

  const search: BookableSearch = {
    service,
    staffMemberId: request.staffMemberId,
    start,
    now,
    templateRuleDefaults,
  };
  const end = start + service.durationMinutes * MINUTE_MS;
  const fits = request.override ? offers(staff, service) : await isBookable(tx, search);
  if (!fits) throw await unavailable(tx, search);
  // The walk-in is added only now, the time found free; a refused write below rolls it back
  // with the booking (the database refuses to commit a walk-in without one, ADR-0052).
  const clientId =
    who.kind === 'existing' ? who.clientId : (await walkInClientIn(tx, actor, who.client)).clientId;

  let row: BookingRow;
  try {
    row = await inSavepoint(tx, (sp) =>
      insertBooking(sp, {
        clientId,
        serviceId: request.serviceId,
        staffMemberId: request.staffMemberId,
        startsAt: new Date(start),
        endsAt: new Date(end),
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        priceFromCents: serviceRow.priceFromCents,
        priceToCents: serviceRow.priceToCents,
        source: options.source ?? 'team',
        overridden: request.override,
        idempotencyKey: key,
        createdBy: actor.context.userId,
      }),
    );
  } catch (error) {
    if (error instanceof BookingOverlapError) throw await unavailable(tx, search);
    if (error instanceof BookingIdempotencyKeyTakenError) {
      // A concurrent request with the same key won the race: answer as the retry would.
      const winner = await retried();
      if (winner === undefined) throw new IdempotencyKeyReusedError();
      return winner;
    }
    throw error;
  }
  await noteFirstBookingIn(tx);
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'booking.created',
      entity: { type: 'booking', id: row.id },
      before: null,
      after: bookingAuditValues(row),
    },
    requestId: actor.requestId,
  });
  await keepReminderInStep(tx, row, now);
  await requestInsights(tx);
  if (request.notifyClient && options.notify) {
    await tellClient(tx, row, 'confirmed', options.notify);
  }
  return toBooking(row);
}

/** One booking. Staff reach only their own (`BookingNotFoundError` otherwise). */
export async function getBooking(
  db: Database,
  actor: Actor,
  bookingId: BookingId,
): Promise<Booking> {
  requirePermission(actor, 'bookings.read');
  return withMember(db, actor.context, (tx) => getBookingIn(tx, actor, bookingId));
}

/** `getBooking` inside the caller's transaction. */
export async function getBookingIn(
  tx: TenantTx,
  actor: Actor,
  bookingId: BookingId,
): Promise<Booking> {
  requirePermission(actor, 'bookings.read');
  const id = BookingIdSchema.parse(bookingId);
  const found = await findBooking(tx, id);
  const own = await ownStaffMemberId(tx, actor, 'bookings.read');
  if (found === undefined || (own !== undefined && found.staffMemberId !== own)) {
    throw new BookingNotFoundError();
  }
  return toBooking(found);
}

/**
 * Bookings whose appointment overlaps [from, to), by start; at most `limit`, earliest first.
 * Staff see only their own.
 */
export async function listBookings(
  db: Database,
  actor: Actor,
  query: BookingsQuery,
  options: { limit?: number } = {},
): Promise<Booking[]> {
  requirePermission(actor, 'bookings.read');
  const parsed = BookingsQuerySchema.parse(query);
  return withMember(db, actor.context, (tx) => listBookingsIn(tx, actor, parsed, options));
}

/** `listBookings` inside the caller's transaction. */
export async function listBookingsIn(
  tx: TenantTx,
  actor: Actor,
  query: BookingsQuery,
  options: { limit?: number } = {},
): Promise<Booking[]> {
  requirePermission(actor, 'bookings.read');
  const { from, to, staffMemberId, clientId, status } = BookingsQuerySchema.parse(query);
  const own = await ownStaffMemberId(tx, actor, 'bookings.read');
  const only = own ?? staffMemberId;
  if (own === null || (own !== undefined && staffMemberId !== undefined && staffMemberId !== own)) {
    return [];
  }
  const rows = await listBookingRows(tx, {
    from: new Date(from),
    to: new Date(to),
    ...(only !== undefined && { staffMemberId: only }),
    ...(clientId !== undefined && { clientId }),
    ...(status !== undefined && { status }),
    ...(options.limit !== undefined && { limit: options.limit }),
  });
  return rows.map(toBooking);
}

/**
 * One client's bookings around `now` (S26b, the AI's "when is Maria next in?"): the next
 * `upcoming` that aren't cancelled, earliest first, and the last `recent` that started before
 * `now` (any status, so a no-show or a cancellation shows), latest first. Staff see only their
 * own bookings, and a client they have none with is not found, as on their screens.
 */
export async function listClientBookingsIn(
  tx: TenantTx,
  actor: Actor,
  clientId: ClientId,
  options: { now: Date; upcoming: number; recent: number },
): Promise<{ upcoming: Booking[]; recent: Booking[] }> {
  requirePermission(actor, 'bookings.read');
  const id = ClientIdSchema.parse(clientId);
  if ((await findClient(tx, id)) === undefined) throw new ClientNotFoundError();
  const own = await ownStaffMemberId(tx, actor, 'bookings.read');
  if (own === null) return { upcoming: [], recent: [] };
  const query = {
    clientId: id,
    now: options.now,
    ...(own !== undefined && { staffMemberId: own }),
  };
  const [upcoming, recent] = [
    await listClientBookings(tx, {
      ...query,
      direction: 'after',
      limit: options.upcoming,
      excludeCancelled: true,
    }),
    await listClientBookings(tx, { ...query, direction: 'before', limit: options.recent }),
  ];
  return { upcoming: upcoming.map(toBooking), recent: recent.map(toBooking) };
}

/**
 * The team's busy times overlapping [from, to): when each staff member is booked; at most
 * `limit`, earliest first.
 */
export async function listBusyTimes(
  db: Database,
  actor: Actor,
  query: BusyQuery,
  options: { limit?: number } = {},
): Promise<BusyTime[]> {
  requirePermission(actor, 'calendar.read');
  const { from, to, staffMemberId } = BusyQuerySchema.parse(query);
  const rows = await withMember(db, actor.context, (tx) =>
    listOccupancy(tx, {
      from: new Date(from),
      to: new Date(to),
      ...(staffMemberId !== undefined && { staffMemberIds: [staffMemberId] }),
      ...(options.limit !== undefined && { limit: options.limit }),
    }),
  );
  return rows.map(toBusyTime);
}

export interface ChangeBookingOptions {
  clock?: Clock;
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** Told about a move or cancellation inside its transaction, when `notifyClient`. */
  notify?: BookingNotify;
}

/**
 * Moves a booking (same client and service; optionally to another staff member who offers
 * it) or changes its status. A cancelled booking is final; completed and no-show need the
 * appointment to have started, and only owners and managers may change them afterwards.
 */
export async function changeBooking(
  db: Database,
  actor: Actor,
  bookingId: BookingId,
  change: BookingChange,
  options: ChangeBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const parsed = BookingChangeSchema.parse(change);
  if ('startsAt' in parsed && parsed.override) requireOverride(actor);
  return withMember(db, actor.context, (tx) => changeBookingIn(tx, actor, id, parsed, options));
}

/** `changeBooking` inside the caller's transaction; a move is written in a savepoint. */
export async function changeBookingIn(
  tx: TenantTx,
  actor: Actor,
  bookingId: BookingId,
  change: BookingChange,
  options: ChangeBookingOptions = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const parsed = BookingChangeSchema.parse(change);
  const now = (options.clock ?? systemClock).now().getTime();
  if ('status' in parsed) {
    const { row } = await lockOwnBooking(tx, actor, id);
    const correctsOutcomes = permissionScope(actor.context.role, 'bookings.manage') === 'all';
    if (!canChangeStatus(BookingStatusSchema.parse(row.status), parsed.status, correctsOutcomes)) {
      throw new BookingNotChangeableError();
    }
    if (statusNeedsStart(parsed.status) && row.startsAt.getTime() > now) {
      throw new BookingNotStartedError();
    }
    const changed = await setBookingStatus(tx, id, parsed.status);
    // The row is locked, so it is still there.
    if (changed === undefined) throw new BookingNotFoundError();
    await keepReminderInStep(tx, changed, now);
    await requestInsights(tx);
    // A cancelled time is offered to the waitlist (S37, AC-W5-1).
    if (parsed.status === 'cancelled') await requestWaitlistMatch(tx, row, now);
    if (parsed.status === 'cancelled' && parsed.notifyClient && options.notify) {
      await tellClient(tx, changed, 'cancelled', options.notify);
    }
    return audited(tx, actor, row, changed);
  }

  if (parsed.override) requireOverride(actor);
  const start = Date.parse(parsed.startsAt);
  const { row, staff } = await lockOwnBooking(tx, actor, id, parsed.staffMemberId);
  if (row.status !== 'confirmed') throw new BookingNotChangeableError();
  const service = bookedService(row);
  const search: BookableSearch = {
    service,
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    excludeBookingId: row.id,
    start,
    now,
    templateRuleDefaults: options.templateRuleDefaults,
  };
  const fits = parsed.override ? offers(staff, service) : await isBookable(tx, search);
  if (!fits) throw await unavailable(tx, search);
  let moved: BookingRow | undefined;
  try {
    moved = await inSavepoint(tx, (sp) =>
      moveBooking(sp, id, {
        staffMemberId: search.staffMemberId,
        startsAt: new Date(start),
        endsAt: new Date(start + service.durationMinutes * MINUTE_MS),
        overridden: parsed.override,
      }),
    );
  } catch (error) {
    if (error instanceof BookingOverlapError) throw await unavailable(tx, search);
    throw error;
  }
  if (moved === undefined) throw new BookingNotFoundError();
  await keepReminderInStep(tx, moved, now);
  await requestInsights(tx);
  // The old time is free now (S37): offered to the waitlist.
  await requestWaitlistMatch(tx, row, now);
  if (parsed.notifyClient && options.notify) {
    await tellClient(tx, moved, 'rescheduled', options.notify);
  }
  return audited(tx, actor, row, moved);
}

/**
 * Puts a no-show back to booked (undoing a no-show the AI marked, S56a), in the caller's
 * transaction. Only owners and managers correct an outcome (the status rules); the client is
 * not emailed.
 */
export async function undoNoShowIn(
  tx: TenantTx,
  actor: Actor,
  bookingId: BookingId,
  options: { clock?: Clock } = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const now = (options.clock ?? systemClock).now().getTime();
  const { row } = await lockOwnBooking(tx, actor, id);
  const correctsOutcomes = permissionScope(actor.context.role, 'bookings.manage') === 'all';
  if (row.status !== 'no_show' || !canChangeStatus('no_show', 'confirmed', correctsOutcomes)) {
    throw new BookingNotChangeableError();
  }
  const changed = await setBookingStatus(tx, id, 'confirmed');
  if (changed === undefined) throw new BookingNotFoundError();
  await keepReminderInStep(tx, changed, now);
  await requestInsights(tx);
  return audited(tx, actor, row, changed);
}

/**
 * Brings back a cancelled booking as it was (undoing a cancellation the AI made, ADR-0028), in
 * the caller's transaction: only before it starts and while its time can still be booked (rules
 * apply; one booked outside them needs an owner or manager again). The client is not emailed.
 */
export async function reinstateBookingIn(
  tx: TenantTx,
  actor: Actor,
  bookingId: BookingId,
  options: { clock?: Clock; templateRuleDefaults?: TemplateRuleDefaultsOf } = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const now = (options.clock ?? systemClock).now().getTime();
  const { row, staff } = await lockOwnBooking(tx, actor, id);
  if (row.status !== 'cancelled') throw new BookingNotChangeableError();
  if (row.startsAt.getTime() <= now) throw new BookingAlreadyStartedError();
  if (row.overridden) requireOverride(actor);
  const service = bookedService(row);
  const search: BookableSearch = {
    service,
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    excludeBookingId: row.id,
    start: row.startsAt.getTime(),
    now,
    templateRuleDefaults: options.templateRuleDefaults,
  };
  const fits = row.overridden ? offers(staff, service) : await isBookable(tx, search);
  if (!fits) throw await unavailable(tx, search);
  let restored: BookingRow | undefined;
  try {
    restored = await inSavepoint(tx, (sp) => setBookingStatus(sp, id, 'confirmed'));
  } catch (error) {
    if (error instanceof BookingOverlapError) throw await unavailable(tx, search);
    throw error;
  }
  if (restored === undefined) throw new BookingNotFoundError();
  await keepReminderInStep(tx, restored, now);
  await requestInsights(tx);
  // The time was never really free: offers made for it close (a match still pending finds no
  // one, the time being booked again).
  await withdrawOffersOfFreedBooking(tx, id);
  return audited(tx, actor, row, restored);
}

/**
 * The staff member whose records the actor reaches with `permission`: `undefined` for every
 * record (owners, managers), the staff member linked to their login for staff, or `null` when
 * staff have none. The database's member scope enforces the same (AC-W9-1); the services
 * check it too, as for every scoped permission (ADR-0013).
 */
export async function ownStaffMemberId(
  tx: TenantTx,
  actor: Actor,
  permission: 'bookings.read' | 'bookings.manage',
): Promise<StaffMemberId | null | undefined> {
  if (permissionScope(actor.context.role, permission) === 'all') return undefined;
  const staff = await findStaffMemberOfUser(tx, actor.context.userId);
  return staff === undefined ? null : StaffMemberIdSchema.parse(staff.id);
}

/** The engine refused the time (internal: answered as `SlotUnavailableError`). */
export class SlotTaken extends Error {}

/** Overriding hours and rules is for owners and managers (`bookings.manage` on every record). */
function requireOverride(actor: Actor): void {
  if (permissionScope(actor.context.role, 'bookings.manage') !== 'all') {
    throw new ForbiddenError('bookings.manage');
  }
}

/** Locks the staff member and checks the actor may book them (staff: only their own). */
async function lockStaff(
  tx: TenantTx,
  actor: Actor,
  staffMemberId: StaffMemberId,
): Promise<StaffMemberRecord> {
  const staff = await lockStaffMember(tx, staffMemberId);
  if (staff === undefined) throw new StaffMemberNotFoundError();
  requirePermission(actor, 'bookings.manage', staffOwner(staff));
  return staff;
}

/**
 * Locks a booking the actor may change (RLS hides other staff members' bookings from staff)
 * and its staff member, plus `moveTo` when moving it to someone else. Staff members are locked
 * in id order, so two moves between the same two people cannot deadlock. Returns the staff
 * member the booking ends up with.
 */
async function lockOwnBooking(
  tx: TenantTx,
  actor: Actor,
  id: BookingId,
  moveTo?: StaffMemberId,
): Promise<{ row: BookingRow; staff: StaffMemberRecord }> {
  const row = await lockBooking(tx, id);
  const own = await ownStaffMemberId(tx, actor, 'bookings.manage');
  // Another staff member's booking is not found, as the database's member scope answers.
  if (row === undefined || (own !== undefined && row.staffMemberId !== own)) {
    throw new BookingNotFoundError();
  }
  const current = StaffMemberIdSchema.parse(row.staffMemberId);
  const target = moveTo ?? current;
  const locked = new Map<string, StaffMemberRecord>();
  // Defence in depth: the service checks what the database's member scope already enforces.
  for (const staffId of [...new Set([current, target])].sort()) {
    locked.set(staffId, await lockStaff(tx, actor, staffId));
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- locked just above
  return { row, staff: locked.get(target)! };
}

/** With override, the staff member must still be active and offer the (active) service. */
function offers(staff: StaffMemberRecord, service: ServiceToBook): boolean {
  return staff.active && service.active && staff.serviceIds.includes(service.id);
}

export interface AlternativesSearch {
  service: ServiceToBook;
  /** `undefined`: anyone who offers the service. */
  staffMemberId: StaffMemberId | undefined;
  start: number;
  now: number;
  excludeBookingId?: string;
  templateRuleDefaults?: TemplateRuleDefaultsOf | undefined;
}

/** A time with one staff member. */
export type BookableSearch = AlternativesSearch & { staffMemberId: StaffMemberId };

/** Whether the engine offers exactly this start time with this staff member. */
export async function isBookable(tx: TenantTx, search: BookableSearch): Promise<boolean> {
  const slots = await slotsFor(tx, {
    service: search.service,
    staffMemberIds: [search.staffMemberId],
    from: search.start,
    to: search.start + 1,
    now: search.now,
    templateRuleDefaults: search.templateRuleDefaults,
    ...(search.excludeBookingId !== undefined && { excludeBookingId: search.excludeBookingId }),
  });
  return slots.some((slot) => slot.start === search.start);
}

/** Opens a transaction for reading alternatives: a member's, or the booking page's. */
export type OpenTransaction = <T>(work: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** The time is not free: the error carries the nearest times that are, read in `tx`. */
async function unavailable(
  tx: TenantTx,
  search: AlternativesSearch,
): Promise<SlotUnavailableError> {
  return new SlotUnavailableError(await nearestAlternatives((work) => work(tx), search));
}

/**
 * Runs one write in a savepoint: a refused write (an overlap, a taken key) rolls back only
 * itself, so the caller's transaction (the trust layer's) stays usable.
 */
function inSavepoint<T>(tx: TenantTx, work: (savepoint: TenantTx) => Promise<T>): Promise<T> {
  return tx.transaction(work);
}

/** The service as this booking was booked (its duration and buffers then). */
function bookedService(row: BookingRow): ServiceToBook {
  return {
    id: ServiceIdSchema.parse(row.serviceId),
    active: true,
    durationMinutes: (row.endsAt.getTime() - row.startsAt.getTime()) / MINUTE_MS,
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
  };
}

/**
 * The nearest bookable times to a refused one, nearest first, with the same service and staff
 * member (`staffMemberId` undefined: anyone, one time per start).
 */
export async function nearestAlternatives(
  open: OpenTransaction,
  search: AlternativesSearch,
): Promise<AvailableSlot[]> {
  const range = alternativesRange(search.start, search.now);
  const slots = await open((tx) =>
    slotsFor(tx, {
      service: search.service,
      staffMemberIds: search.staffMemberId === undefined ? undefined : [search.staffMemberId],
      ...range,
      now: search.now,
      templateRuleDefaults: search.templateRuleDefaults,
      ...(search.excludeBookingId !== undefined && { excludeBookingId: search.excludeBookingId }),
    }),
  );
  const firstPerStart = slots.filter(
    (slot, index) => slots.findIndex((other) => other.start === slot.start) === index,
  );
  return nearestSlots(firstPerStart, search.start, ALTERNATIVE_SLOT_COUNT).map(toAvailableSlot);
}

/** Audits a change of `before` to `after` (unless nothing changed) and returns the booking. */
/**
 * Tells the client about a team change of their booking, if the business has their email
 * address. A confirmation or move comes with a new reschedule/cancel link (the old one, if
 * any, stops working), because only the link's hash is stored.
 */
async function tellClient(
  tx: TenantTx,
  row: BookingRow,
  kind: 'confirmed' | 'rescheduled' | 'cancelled',
  notify: BookingNotify,
): Promise<void> {
  const tenant = await findCurrentTenant(tx);
  // The transaction's own business always exists.
  if (tenant === undefined) throw new BookingNotFoundError();
  const email = await emailDetailsOf(tx, tenant, row);
  if (email.email === '') return;
  if (kind === 'cancelled') {
    await notify(tx, { kind, email, change: changeOf(row) });
    return;
  }
  const link = newManageToken();
  const linked = await setBookingManageTokenHash(tx, BookingIdSchema.parse(row.id), link.hash);
  await notify(tx, { kind, email, manageToken: link.token, change: changeOf(linked ?? row) });
}

async function audited(
  tx: TenantTx,
  actor: Actor,
  before: BookingRow,
  after: BookingRow | undefined,
): Promise<Booking> {
  // The row is locked, so it is still there.
  if (after === undefined) throw new BookingNotFoundError();
  const values = { before: bookingAuditValues(before), after: bookingAuditValues(after) };
  if (!sameValues(values.before, values.after)) {
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: { action: 'booking.updated', entity: { type: 'booking', id: after.id }, ...values },
      requestId: actor.requestId,
    });
  }
  return toBooking(after);
}
