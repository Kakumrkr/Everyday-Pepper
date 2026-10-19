import {
  ALTERNATIVE_SLOT_COUNT,
  BookingChangeSchema,
  BookingIdSchema,
  BookingInputSchema,
  BookingsQuerySchema,
  BookingStatusSchema,
  BusyQuerySchema,
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
  type StaffMemberId,
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
  appendAuditEntry,
  BookingIdempotencyKeyTakenError,
  BookingOverlapError,
  findBooking,
  findBookingByIdempotencyKey,
  findService,
  findStaffMemberOfUser,
  insertBooking,
  listBookings as listBookingRows,
  listOccupancy,
  lockBooking,
  lockStaffMember,
  moveBooking,
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
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingNotStartedError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
} from '../errors.js';
import { bookingAuditValues, sameValues, staffOwner, toBooking, toBusyTime } from '../mapping.js';
import { serviceToBook, slotsFor, type TemplateRuleDefaultsOf } from './availability.js';
import { findClientToBook } from './clients.js';

// Bookings (ADR-0017). `bookings.manage` lets owners and managers book anyone and staff only
// their own staff member (AC-W9-1); the database's member scope enforces the same, so staff
// never even see other staff members' bookings. A booking must fit the availability engine
// (hours, time off, rules, other bookings), except that owners and managers may override hours
// and rules; the exclusion constraint refuses overlaps in every case, also under races. The
// staff member is locked while a booking is checked and written, so their daily cap holds
// under concurrency too.

const MINUTE_MS = 60_000;

/** Books a client. `SlotUnavailableError` (with alternatives) when the time is not free. */
export async function createBooking(
  db: Database,
  actor: Actor,
  input: BookingInput,
  options: {
    clock?: Clock;
    source?: BookingSource;
    templateRuleDefaults?: TemplateRuleDefaultsOf;
  } = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const request = BookingInputSchema.parse(input);
  if (request.override) requireOverride(actor);
  const now = (options.clock ?? systemClock).now().getTime();
  const start = Date.parse(request.startsAt);
  const key = request.idempotencyKey ?? null;
  const { templateRuleDefaults } = options;
  const sameRequest = (row: BookingRow) =>
    row.clientId === request.clientId &&
    row.serviceId === request.serviceId &&
    row.staffMemberId === request.staffMemberId &&
    row.startsAt.getTime() === start;

  let service: ServiceToBook | undefined;
  try {
    return await withMember(db, actor.context, async (tx) => {
      const staff = await lockStaff(tx, actor, request.staffMemberId);
      // After the lock: a concurrent first attempt with the key (same staff member) has
      // committed by now, so a retry returns its booking instead of finding the time taken.
      if (key !== null) {
        const existing = await findBookingByIdempotencyKey(tx, key);
        if (existing !== undefined) {
          if (!sameRequest(existing)) throw new IdempotencyKeyReusedError();
          return toBooking(existing);
        }
      }
      const serviceRow = await findService(tx, request.serviceId);
      if (serviceRow === undefined) throw new ServiceNotFoundError();
      service = serviceToBook(serviceRow);
      await findClientToBook(tx, request.clientId, request.clientContact);

      const end = start + service.durationMinutes * MINUTE_MS;
      const fits = request.override
        ? offers(staff, service)
        : await isBookable(tx, {
            service,
            staffMemberId: request.staffMemberId,
            start,
            now,
            templateRuleDefaults,
          });
      if (!fits) throw new SlotTaken();

      const row = await insertBooking(tx, {
        clientId: request.clientId,
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
      });
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: {
          action: 'booking.created',
          entity: { type: 'booking', id: row.id },
          before: null,
          after: bookingAuditValues(row),
        },
        requestId: actor.requestId,
      });
      return toBooking(row);
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && service) {
      throw new SlotUnavailableError(
        await alternatives(db, actor, {
          service,
          staffMemberId: request.staffMemberId,
          start,
          now,
          templateRuleDefaults,
        }),
      );
    }
    if (error instanceof BookingIdempotencyKeyTakenError && key !== null) {
      // A concurrent request with the same key won the race: answer as the retry would.
      const existing = await withMember(db, actor.context, (tx) =>
        findBookingByIdempotencyKey(tx, key),
      );
      if (existing === undefined || !sameRequest(existing)) throw new IdempotencyKeyReusedError();
      return toBooking(existing);
    }
    throw error;
  }
}

/** One booking. Staff reach only their own (`BookingNotFoundError` otherwise). */
export async function getBooking(
  db: Database,
  actor: Actor,
  bookingId: BookingId,
): Promise<Booking> {
  requirePermission(actor, 'bookings.read');
  const id = BookingIdSchema.parse(bookingId);
  const row = await withMember(db, actor.context, async (tx) => {
    const found = await findBooking(tx, id);
    const own = await ownStaffMemberId(tx, actor, 'bookings.read');
    return own === undefined || found?.staffMemberId === own ? found : undefined;
  });
  if (row === undefined) throw new BookingNotFoundError();
  return toBooking(row);
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
  const { from, to, staffMemberId, status } = BookingsQuerySchema.parse(query);
  const rows = await withMember(db, actor.context, async (tx) => {
    const own = await ownStaffMemberId(tx, actor, 'bookings.read');
    const only = own ?? staffMemberId;
    if (
      own === null ||
      (own !== undefined && staffMemberId !== undefined && staffMemberId !== own)
    ) {
      return [];
    }
    return listBookingRows(tx, {
      from: new Date(from),
      to: new Date(to),
      ...(only !== undefined && { staffMemberId: only }),
      ...(status !== undefined && { status }),
      ...(options.limit !== undefined && { limit: options.limit }),
    });
  });
  return rows.map(toBooking);
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
  options: { clock?: Clock; templateRuleDefaults?: TemplateRuleDefaultsOf } = {},
): Promise<Booking> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const parsed = BookingChangeSchema.parse(change);
  const now = (options.clock ?? systemClock).now().getTime();
  if ('status' in parsed) {
    return withMember(db, actor.context, async (tx) => {
      const { row } = await lockOwnBooking(tx, actor, id);
      const correctsOutcomes = permissionScope(actor.context.role, 'bookings.manage') === 'all';
      if (
        !canChangeStatus(BookingStatusSchema.parse(row.status), parsed.status, correctsOutcomes)
      ) {
        throw new BookingNotChangeableError();
      }
      if (statusNeedsStart(parsed.status) && row.startsAt.getTime() > now) {
        throw new BookingNotStartedError();
      }
      return audited(tx, actor, row, await setBookingStatus(tx, id, parsed.status));
    });
  }

  if (parsed.override) requireOverride(actor);
  const start = Date.parse(parsed.startsAt);
  let search: Omit<AlternativesSearch, 'start' | 'now'> | undefined;
  try {
    return await withMember(db, actor.context, async (tx) => {
      const { row, staff } = await lockOwnBooking(tx, actor, id, parsed.staffMemberId);
      if (row.status !== 'confirmed') throw new BookingNotChangeableError();
      const target = StaffMemberIdSchema.parse(staff.id);
      // The booking keeps the service as it was booked (duration and buffers).
      const service: ServiceToBook = {
        id: ServiceIdSchema.parse(row.serviceId),
        active: true,
        durationMinutes: (row.endsAt.getTime() - row.startsAt.getTime()) / MINUTE_MS,
        bufferBeforeMinutes: row.bufferBeforeMinutes,
        bufferAfterMinutes: row.bufferAfterMinutes,
      };
      search = {
        service,
        staffMemberId: target,
        excludeBookingId: row.id,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      const fits = parsed.override
        ? offers(staff, service)
        : await isBookable(tx, { ...search, start, now });
      if (!fits) throw new SlotTaken();
      const moved = await moveBooking(tx, id, {
        staffMemberId: target,
        startsAt: new Date(start),
        endsAt: new Date(start + service.durationMinutes * MINUTE_MS),
        overridden: parsed.override,
      });
      return audited(tx, actor, row, moved);
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && search) {
      throw new SlotUnavailableError(await alternatives(db, actor, { ...search, start, now }));
    }
    throw error;
  }
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
class SlotTaken extends Error {}

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

interface AlternativesSearch {
  service: ServiceToBook;
  staffMemberId: StaffMemberId;
  start: number;
  now: number;
  excludeBookingId?: string;
  templateRuleDefaults?: TemplateRuleDefaultsOf | undefined;
}

/** Whether the engine offers exactly this start time with this staff member. */
async function isBookable(tx: TenantTx, search: AlternativesSearch): Promise<boolean> {
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

/** The nearest bookable times instead, read after the refused transaction rolled back. */
async function alternatives(
  db: Database,
  actor: Actor,
  search: AlternativesSearch,
): Promise<AvailableSlot[]> {
  const range = alternativesRange(search.start, search.now);
  const slots = await withMember(db, actor.context, (tx) =>
    slotsFor(tx, {
      service: search.service,
      staffMemberIds: [search.staffMemberId],
      ...range,
      now: search.now,
      templateRuleDefaults: search.templateRuleDefaults,
      ...(search.excludeBookingId !== undefined && { excludeBookingId: search.excludeBookingId }),
    }),
  );
  return nearestSlots(slots, search.start, ALTERNATIVE_SLOT_COUNT).map(toAvailableSlot);
}

/** Audits a change of `before` to `after` (unless nothing changed) and returns the booking. */
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
      actor: { kind: 'user', userId: actor.context.userId },
      change: { action: 'booking.updated', entity: { type: 'booking', id: after.id }, ...values },
      requestId: actor.requestId,
    });
  }
  return toBooking(after);
}
