import {
  BookingSourceSchema,
  BookingStatusSchema,
  IdempotencyKeySchema,
  WaitlistEntryInputSchema,
  type BookingId,
  type BookingSource,
  type BookingStatus,
  type ClientId,
  type ServiceId,
  type StaffMemberId,
  type UserId,
  type WaitlistEntryId,
  type WaitlistWindow,
} from '@pepper/contracts';
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  BookingIdempotencyKeyTakenError,
  BookingOverlapError,
  isExclusionViolation,
  isUniqueViolation,
} from '../errors.js';
import {
  bookingManageLinks,
  bookingOccupancy,
  bookings,
  waitlistEntries,
  type BookingRow,
  type WaitlistEntryRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Bookings, the time they occupy, and the waitlist of the transaction's tenant (ADR-0017). Run
// inside `withMember` for a member's request: the `member_scope` policies then limit staff to
// their own staff member's bookings and waitlist entries (AC-W9-1). `booking_occupancy` is
// written only by the bookings trigger; everyone in the business may read it.

const Id = z.uuid();
const TokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

// Bookings ----------------------------------------------------------------------------------

export interface NewBooking {
  clientId: ClientId;
  serviceId: ServiceId;
  staffMemberId: StaffMemberId;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceFromCents: number | null;
  priceToCents: number | null;
  source: BookingSource;
  overridden: boolean;
  idempotencyKey: string | null;
  createdBy: UserId | null;
  /** SHA-256 (hex) of the client's reschedule/cancel link token (booking page, ADR-0022). */
  manageTokenHash?: string | null;
}

/**
 * Throws `BookingOverlapError` when the staff member is already booked at that time (buffers
 * included), `BookingIdempotencyKeyTakenError` when another booking has the key.
 */
export async function insertBooking(tx: TenantTx, input: NewBooking): Promise<BookingRow> {
  const values = {
    clientId: Id.parse(input.clientId),
    serviceId: Id.parse(input.serviceId),
    staffMemberId: Id.parse(input.staffMemberId),
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    bufferBeforeMinutes: input.bufferBeforeMinutes,
    bufferAfterMinutes: input.bufferAfterMinutes,
    priceFromCents: input.priceFromCents,
    priceToCents: input.priceToCents,
    source: BookingSourceSchema.parse(input.source),
    overridden: input.overridden,
    idempotencyKey:
      input.idempotencyKey === null ? null : IdempotencyKeySchema.parse(input.idempotencyKey),
    createdByUserId: input.createdBy === null ? null : Id.parse(input.createdBy),
    manageTokenHash:
      input.manageTokenHash === undefined || input.manageTokenHash === null
        ? null
        : TokenHashSchema.parse(input.manageTokenHash),
  };
  return bookingWrite(async () => {
    const [row] = await tx.insert(bookings).values(values).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return row!;
  });
}

/** The booking with this id, if the transaction may see it. */
export async function findBooking(tx: TenantTx, id: BookingId): Promise<BookingRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookings)
    .where(eq(bookings.id, Id.parse(id)));
  return row;
}

/** The booking with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockBooking(tx: TenantTx, id: BookingId): Promise<BookingRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookings)
    .where(eq(bookings.id, Id.parse(id)))
    .for('update');
  return row;
}

/** The booking made with this idempotency key, if the transaction may see it. */
export async function findBookingByIdempotencyKey(
  tx: TenantTx,
  key: string,
): Promise<BookingRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookings)
    .where(eq(bookings.idempotencyKey, IdempotencyKeySchema.parse(key)));
  return row;
}

export interface BookingMove {
  staffMemberId: StaffMemberId;
  startsAt: Date;
  endsAt: Date;
  overridden: boolean;
}

/** Moves a booking; throws `BookingOverlapError` when the new time is taken. */
export async function moveBooking(
  tx: TenantTx,
  id: BookingId,
  move: BookingMove,
): Promise<BookingRow | undefined> {
  return bookingWrite(async () => {
    const [row] = await tx
      .update(bookings)
      .set({
        staffMemberId: Id.parse(move.staffMemberId),
        startsAt: move.startsAt,
        endsAt: move.endsAt,
        overridden: move.overridden,
        // A client's "C" was for the time they were reminded of (S62): a new time clears it.
        clientConfirmedAt: sql`CASE WHEN ${bookings.startsAt} = ${move.startsAt} THEN ${bookings.clientConfirmedAt} ELSE NULL END`,
      })
      .where(eq(bookings.id, Id.parse(id)))
      .returning();
    return row;
  });
}

/** Sets a booking's status (the trigger frees its time when cancelled). */
export async function setBookingStatus(
  tx: TenantTx,
  id: BookingId,
  status: BookingStatus,
): Promise<BookingRow | undefined> {
  return bookingWrite(async () => {
    const [row] = await tx
      .update(bookings)
      .set({ status: BookingStatusSchema.parse(status) })
      .where(eq(bookings.id, Id.parse(id)))
      .returning();
    return row;
  });
}

/**
 * Replaces a booking's reschedule/cancel link (ADR-0025): the old link stops working, and so do
 * the links its reminders carried (S62). `hash` is the SHA-256 (hex) of the new token, which
 * only the client's email carries.
 */
export async function setBookingManageTokenHash(
  tx: TenantTx,
  id: BookingId,
  hash: string,
): Promise<BookingRow | undefined> {
  await tx.delete(bookingManageLinks).where(eq(bookingManageLinks.bookingId, Id.parse(id)));
  const [row] = await tx
    .update(bookings)
    .set({ manageTokenHash: TokenHashSchema.parse(hash) })
    .where(eq(bookings.id, Id.parse(id)))
    .returning();
  return row;
}

/**
 * Bookings whose appointment overlaps [from, to), by start; optionally of one staff member, of
 * one client or with one status. Staff see only their own (RLS).
 */
export async function listBookings(
  tx: TenantTx,
  options: {
    from: Date;
    to: Date;
    staffMemberId?: StaffMemberId;
    clientId?: ClientId;
    status?: BookingStatus;
    /** At most this many rows, earliest first. */
    limit?: number;
  },
): Promise<BookingRow[]> {
  const conditions: SQL[] = [lt(bookings.startsAt, options.to), gt(bookings.endsAt, options.from)];
  if (options.staffMemberId !== undefined) {
    conditions.push(eq(bookings.staffMemberId, Id.parse(options.staffMemberId)));
  }
  if (options.clientId !== undefined) {
    conditions.push(eq(bookings.clientId, Id.parse(options.clientId)));
  }
  if (options.status !== undefined) {
    conditions.push(eq(bookings.status, BookingStatusSchema.parse(options.status)));
  }
  const query = tx
    .select()
    .from(bookings)
    .where(and(...conditions))
    .orderBy(asc(bookings.startsAt), asc(bookings.id));
  return options.limit === undefined ? query : query.limit(options.limit);
}

/**
 * One client's bookings either side of `now` (S26b), with no window: those starting at or
 * after it earliest first (`after`), or those that started before it latest first (`before`);
 * at most `limit`. Staff see only their own (RLS).
 */
export async function listClientBookings(
  tx: TenantTx,
  options: {
    clientId: ClientId;
    now: Date;
    direction: 'after' | 'before';
    limit: number;
    staffMemberId?: StaffMemberId;
    excludeCancelled?: boolean;
  },
): Promise<BookingRow[]> {
  const conditions: SQL[] = [
    eq(bookings.clientId, Id.parse(options.clientId)),
    options.direction === 'after'
      ? gte(bookings.startsAt, options.now)
      : lt(bookings.startsAt, options.now),
  ];
  if (options.staffMemberId !== undefined) {
    conditions.push(eq(bookings.staffMemberId, Id.parse(options.staffMemberId)));
  }
  if (options.excludeCancelled === true) conditions.push(ne(bookings.status, 'cancelled'));
  const order =
    options.direction === 'after'
      ? [asc(bookings.startsAt), asc(bookings.id)]
      : [desc(bookings.startsAt), desc(bookings.id)];
  return tx
    .select()
    .from(bookings)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(z.number().int().min(1).max(50).parse(options.limit));
}

async function bookingWrite<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (isExclusionViolation(error, 'booking_occupancy_no_overlap')) {
      throw new BookingOverlapError({ cause: error });
    }
    if (isUniqueViolation(error, 'bookings_tenant_idempotency_key_unique')) {
      throw new BookingIdempotencyKeyTakenError({ cause: error });
    }
    throw error;
  }
}

// Occupied time ------------------------------------------------------------------------------

/** The time an active booking occupies: its appointment, and with buffers. */
export interface Occupancy {
  bookingId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  occupiedFrom: Date;
  occupiedTo: Date;
}

/**
 * Occupied times (of active bookings) overlapping [from, to), by start; optionally only of
 * some staff members. Readable by everyone in the business: no booking details.
 */
export async function listOccupancy(
  tx: TenantTx,
  options: {
    from: Date;
    to: Date;
    staffMemberIds?: readonly StaffMemberId[];
    /** At most this many rows, earliest first. */
    limit?: number;
  },
): Promise<Occupancy[]> {
  const conditions: SQL[] = [
    sql`${bookingOccupancy.occupied} && tstzrange(${options.from.toISOString()}::timestamptz, ${options.to.toISOString()}::timestamptz, '[)')`,
  ];
  if (options.staffMemberIds !== undefined) {
    if (options.staffMemberIds.length === 0) return [];
    conditions.push(
      inArray(
        bookingOccupancy.staffMemberId,
        options.staffMemberIds.map((id) => Id.parse(id)),
      ),
    );
  }
  const query = tx
    .select({
      bookingId: bookingOccupancy.id,
      staffMemberId: bookingOccupancy.staffMemberId,
      startsAt: bookingOccupancy.startsAt,
      endsAt: bookingOccupancy.endsAt,
      occupiedFrom: sql<string>`lower(${bookingOccupancy.occupied})`,
      occupiedTo: sql<string>`upper(${bookingOccupancy.occupied})`,
    })
    .from(bookingOccupancy)
    .where(and(...conditions))
    .orderBy(asc(bookingOccupancy.startsAt), asc(bookingOccupancy.id));
  const rows = await (options.limit === undefined ? query : query.limit(options.limit));
  return rows.map((row) => ({
    ...row,
    // Raw expressions come back as Postgres text, not through the column's Date mapping.
    occupiedFrom: new Date(row.occupiedFrom),
    occupiedTo: new Date(row.occupiedTo),
  }));
}

// Waitlist ----------------------------------------------------------------------------------

export interface NewWaitlistEntry {
  clientId: ClientId;
  serviceId: ServiceId;
  staffMemberId: StaffMemberId | null;
  windows: WaitlistWindow[];
  expiresAt: Date;
  /** `null`: the client added themselves on the booking page (S38a). */
  createdBy: UserId | null;
}

export async function insertWaitlistEntry(
  tx: TenantTx,
  input: NewWaitlistEntry,
): Promise<WaitlistEntryRow> {
  const windows = WaitlistEntryInputSchema.shape.windows.parse(input.windows);
  const [row] = await tx
    .insert(waitlistEntries)
    .values({
      clientId: Id.parse(input.clientId),
      serviceId: Id.parse(input.serviceId),
      staffMemberId: input.staffMemberId === null ? null : Id.parse(input.staffMemberId),
      windows,
      expiresAt: input.expiresAt,
      createdByUserId: input.createdBy === null ? null : Id.parse(input.createdBy),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** The waitlist entry with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockWaitlistEntry(
  tx: TenantTx,
  id: WaitlistEntryId,
): Promise<WaitlistEntryRow | undefined> {
  const [row] = await tx
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.id, Id.parse(id)))
    .for('update');
  return row;
}

/** Sets a waitlist entry's status to cancelled. */
export async function cancelWaitlistEntry(
  tx: TenantTx,
  id: WaitlistEntryId,
): Promise<WaitlistEntryRow | undefined> {
  const [row] = await tx
    .update(waitlistEntries)
    .set({ status: 'cancelled' })
    .where(eq(waitlistEntries.id, Id.parse(id)))
    .returning();
  return row;
}

/**
 * Waitlist entries by when they were added (longest waiting first), at most `limit`. Unless
 * `all`, only open ones: waiting or offered, and not expired at `now`.
 */
export async function listWaitlistEntries(
  tx: TenantTx,
  options: { now: Date; all: boolean; serviceId?: ServiceId; clientId?: ClientId; limit: number },
): Promise<WaitlistEntryRow[]> {
  const conditions: (SQL | undefined)[] = [];
  if (!options.all) {
    conditions.push(
      or(eq(waitlistEntries.status, 'waiting'), eq(waitlistEntries.status, 'offered')),
      gt(waitlistEntries.expiresAt, options.now),
    );
  }
  if (options.serviceId !== undefined) {
    conditions.push(eq(waitlistEntries.serviceId, Id.parse(options.serviceId)));
  }
  if (options.clientId !== undefined) {
    conditions.push(eq(waitlistEntries.clientId, Id.parse(options.clientId)));
  }
  return tx
    .select()
    .from(waitlistEntries)
    .where(and(...conditions))
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id))
    .limit(z.number().int().min(1).max(200).parse(options.limit));
}
