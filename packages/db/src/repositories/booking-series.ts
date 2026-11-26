import {
  IdempotencyKeySchema,
  type BookingSeriesId,
  type StaffMemberId,
  type UserId,
} from '@pepper/contracts';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isUniqueViolation } from '../errors.js';
import { bookingSeries, bookings, type BookingRow, type BookingSeriesRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Series of recurring visits (S72, ADR-0070) of the transaction's tenant. Run inside
// `withMember` for a member's request: the `member_scope` policy then limits staff to their own
// staff member's series, as their bookings (AC-W9-1). Each visit is a booking with `series_id`.

const Id = z.uuid();

export interface NewBookingSeries {
  staffMemberId: StaffMemberId;
  everyWeeks: number;
  requestedStarts: Date[];
  idempotencyKey: string | null;
  createdBy: UserId | null;
}

/** Another series of the business already has this idempotency key. */
export class BookingSeriesKeyTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super('Another series already has this idempotency key', options);
    this.name = 'BookingSeriesKeyTakenError';
  }
}

/** Throws `BookingSeriesKeyTakenError` when another series has the key. */
export async function insertBookingSeries(
  tx: TenantTx,
  input: NewBookingSeries,
): Promise<BookingSeriesRow> {
  const values = {
    staffMemberId: Id.parse(input.staffMemberId),
    everyWeeks: input.everyWeeks,
    requestedStarts: input.requestedStarts,
    idempotencyKey:
      input.idempotencyKey === null ? null : IdempotencyKeySchema.parse(input.idempotencyKey),
    createdByUserId: input.createdBy === null ? null : Id.parse(input.createdBy),
  };
  try {
    const [row] = await tx.insert(bookingSeries).values(values).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return row!;
  } catch (error) {
    if (isUniqueViolation(error, 'booking_series_tenant_idempotency_key_unique')) {
      throw new BookingSeriesKeyTakenError({ cause: error });
    }
    throw error;
  }
}

/** Records the asked start times that weren't free, for a retry's answer. */
export async function setBookingSeriesSkipped(
  tx: TenantTx,
  id: BookingSeriesId,
  skipped: Date[],
): Promise<void> {
  await tx
    .update(bookingSeries)
    .set({ skippedStarts: skipped })
    .where(eq(bookingSeries.id, Id.parse(id)));
}

/** The series with this id, if the transaction may see it. */
export async function findBookingSeries(
  tx: TenantTx,
  id: BookingSeriesId,
): Promise<BookingSeriesRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingSeries)
    .where(eq(bookingSeries.id, Id.parse(id)));
  return row;
}

/** The series made with this idempotency key, if the transaction may see it. */
export async function findBookingSeriesByIdempotencyKey(
  tx: TenantTx,
  key: string,
): Promise<BookingSeriesRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingSeries)
    .where(eq(bookingSeries.idempotencyKey, IdempotencyKeySchema.parse(key)));
  return row;
}

/** The series' visits the transaction may see, any status, earliest first. */
export async function listSeriesBookings(tx: TenantTx, id: BookingSeriesId): Promise<BookingRow[]> {
  return tx
    .select()
    .from(bookings)
    .where(eq(bookings.seriesId, Id.parse(id)))
    .orderBy(asc(bookings.startsAt), asc(bookings.id));
}
