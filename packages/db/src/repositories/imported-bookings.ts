import { ImportBatchIdSchema, type ImportBatchId } from '@pepper/contracts';
import { and, asc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { BookingOverlapError, isExclusionViolation } from '../errors.js';
import { bookings, memberships, staffMembers } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Bookings an import brings (S49, ADR-0050): past visits and upcoming appointments from another
// tool's export, written with `source` import and their batch. Only the appointments module's
// `importVisitBook` calls these, in the import run's tenant transaction; nothing here plans a
// reminder or queues an email. Imported past visits (completed, no-show) occupy no time (the
// occupancy trigger, migration 0059); upcoming ones do, and the exclusion constraint refuses an
// overlap as for any booking.

const Id = z.uuid();
const CHUNK = 500;

export interface NewImportedBooking {
  /** Made by the caller, so each row knows its booking. */
  id: string;
  clientId: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceFromCents: number | null;
  status: 'completed' | 'no_show' | 'confirmed';
  createdBy: string | null;
}

/**
 * Inserts imported bookings in one statement per 500. Throws `BookingOverlapError` when one of
 * them overlaps another booking of its staff member (only upcoming ones can).
 */
export async function insertImportedBookings(
  tx: TenantTx,
  batchId: ImportBatchId,
  rows: readonly NewImportedBooking[],
): Promise<void> {
  const batch = ImportBatchIdSchema.parse(batchId);
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK).map((row) => ({
      id: Id.parse(row.id),
      clientId: Id.parse(row.clientId),
      serviceId: Id.parse(row.serviceId),
      staffMemberId: Id.parse(row.staffMemberId),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      bufferBeforeMinutes: row.bufferBeforeMinutes,
      bufferAfterMinutes: row.bufferAfterMinutes,
      priceFromCents: row.priceFromCents,
      priceToCents: null,
      status: z.enum(['completed', 'no_show', 'confirmed']).parse(row.status),
      source: 'import',
      overridden: false,
      createdByUserId: row.createdBy === null ? null : Id.parse(row.createdBy),
      importBatchId: batch,
    }));
    try {
      await tx.insert(bookings).values(part);
    } catch (error) {
      if (isExclusionViolation(error, 'booking_occupancy_no_overlap')) {
        throw new BookingOverlapError({ cause: error });
      }
      throw error;
    }
  }
}

/** The starts of these clients' bookings (not cancelled) in [from, to): visits Pepper has. */
export async function listClientBookingStarts(
  tx: TenantTx,
  clientIds: readonly string[],
  from: Date,
  to: Date,
): Promise<{ clientId: string; startsAt: Date }[]> {
  const out: { clientId: string; startsAt: Date }[] = [];
  const ids = z.array(Id).parse(clientIds);
  for (let i = 0; i < ids.length; i += CHUNK) {
    out.push(
      ...(await tx
        .select({ clientId: bookings.clientId, startsAt: bookings.startsAt })
        .from(bookings)
        .where(
          and(
            inArray(bookings.clientId, ids.slice(i, i + CHUNK)),
            gte(bookings.startsAt, from),
            lt(bookings.startsAt, to),
            ne(bookings.status, 'cancelled'),
          ),
        )),
    );
  }
  return out;
}

/**
 * Removes the bookings this import made that nobody has changed since (never updated, no visit
 * note); returns how many went and how many stay.
 */
export async function undoImportedBookings(
  tx: TenantTx,
  batchId: ImportBatchId,
): Promise<{ deleted: number; kept: number }> {
  const batch = ImportBatchIdSchema.parse(batchId);
  const result = await tx.execute<{ total: number; deleted: number }>(sql`
    WITH made AS (
      SELECT id, created_at, updated_at FROM bookings WHERE import_batch_id = ${batch}
    ), removed AS (
      DELETE FROM bookings b USING made
      WHERE b.id = made.id
        AND made.updated_at = made.created_at
        AND NOT EXISTS (SELECT 1 FROM memory_facts f WHERE f.booking_id = b.id)
      RETURNING b.id
    )
    SELECT (SELECT count(*) FROM made)::int AS total,
           (SELECT count(*) FROM removed)::int AS deleted`);
  const counts = result.rows[0] ?? { total: 0, deleted: 0 };
  return { deleted: counts.deleted, kept: counts.total - counts.deleted };
}

/**
 * The staff member imported visits without a known staff member go to: the importing member's
 * own, else the owner's, else the business's first active one; `undefined` with no staff.
 */
export async function findImportDefaultStaffMemberId(
  tx: TenantTx,
  userId: string | null,
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: staffMembers.id })
    .from(staffMembers)
    .leftJoin(memberships, eq(memberships.id, staffMembers.membershipId))
    .where(eq(staffMembers.active, true))
    .orderBy(
      sql`CASE WHEN ${memberships.userId} = ${userId === null ? null : Id.parse(userId)}::uuid THEN 0 WHEN ${memberships.role} = 'owner' THEN 1 ELSE 2 END`,
      asc(staffMembers.createdAt),
      asc(staffMembers.id),
    )
    .limit(1);
  return row?.id;
}
