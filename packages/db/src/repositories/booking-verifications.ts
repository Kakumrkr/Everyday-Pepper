import {
  BookingRequestIdSchema,
  ClientEmailSchema,
  PhoneSchema,
  SmsConsentWordingVersionSchema,
  type SmsConsentWordingVersion,
  type BookingId,
  type BookingRequestId,
  type ServiceId,
  type StaffMemberId,
  type WaitlistEntryId,
} from '@pepper/contracts';
import { and, count, eq, gt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  bookingVerifications,
  bookings,
  type BookingRow,
  type BookingVerificationRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Booking requests from the public booking page that wait for their email code, and the
// reschedule/cancel links of the bookings made from them (ADR-0022). Run inside
// `withPublicTenant`: members never reach the requests (their `member_scope` policy).

const Id = z.uuid();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

export interface NewBookingVerification {
  serviceId: ServiceId;
  staffMemberId: StaffMemberId | null;
  startsAt: Date;
  name: string;
  email: string;
  phone: string | null;
  codeHash: string;
  expiresAt: Date;
  /** `waitlist` (S38a): the code adds the client to the waitlist for that local day. */
  purpose?: 'booking' | 'waitlist';
  /** The SMS box the client ticked (S61.2): its wording, recorded as a consent on confirmation. */
  smsConsentVersion?: SmsConsentWordingVersion | null;
}

export async function insertBookingVerification(
  tx: TenantTx,
  input: NewBookingVerification,
): Promise<BookingVerificationRow> {
  const [row] = await tx
    .insert(bookingVerifications)
    .values({
      serviceId: Id.parse(input.serviceId),
      staffMemberId: input.staffMemberId === null ? null : Id.parse(input.staffMemberId),
      startsAt: input.startsAt,
      name: z.string().trim().min(1).max(120).parse(input.name),
      email: ClientEmailSchema.parse(input.email),
      phone: input.phone === null ? null : PhoneSchema.parse(input.phone),
      codeHash: HashSchema.parse(input.codeHash),
      expiresAt: input.expiresAt,
      purpose: z.enum(['booking', 'waitlist']).parse(input.purpose ?? 'booking'),
      smsConsentVersion:
        input.smsConsentVersion === undefined || input.smsConsentVersion === null
          ? null
          : SmsConsentWordingVersionSchema.parse(input.smsConsentVersion),
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return row!;
}

/** The request with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockBookingVerification(
  tx: TenantTx,
  id: BookingRequestId,
): Promise<BookingVerificationRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookingVerifications)
    .where(eq(bookingVerifications.id, BookingRequestIdSchema.parse(id)))
    .for('update');
  return row;
}

/** Counts one more code typed for the request; returns the new count. */
export async function addVerificationAttempt(tx: TenantTx, id: BookingRequestId): Promise<number> {
  const [row] = await tx
    .update(bookingVerifications)
    .set({ attempts: sql`${bookingVerifications.attempts} + 1` })
    .where(eq(bookingVerifications.id, BookingRequestIdSchema.parse(id)))
    .returning({ attempts: bookingVerifications.attempts });
  if (row === undefined) throw new Error('Booking request not found');
  return row.attempts;
}

/**
 * Keeps a request open until at least `until` (S66: a client typing a card outlives the code's
 * ten minutes); never shortens it.
 */
export async function extendBookingVerification(
  tx: TenantTx,
  id: BookingRequestId,
  until: Date,
): Promise<void> {
  await tx
    .update(bookingVerifications)
    .set({
      expiresAt: sql`GREATEST(${bookingVerifications.expiresAt}, ${until.toISOString()}::timestamptz)`,
    })
    .where(eq(bookingVerifications.id, BookingRequestIdSchema.parse(id)));
}

/** Records the booking a request's code confirmed; it cannot be used again. */
export async function setVerificationBooking(
  tx: TenantTx,
  id: BookingRequestId,
  bookingId: BookingId,
): Promise<void> {
  await tx
    .update(bookingVerifications)
    .set({ bookingId: Id.parse(bookingId) })
    .where(eq(bookingVerifications.id, BookingRequestIdSchema.parse(id)));
}

/** Records the waitlist entry a request's code added (S38a); it cannot be used again. */
export async function setVerificationWaitlistEntry(
  tx: TenantTx,
  id: BookingRequestId,
  entryId: WaitlistEntryId,
): Promise<void> {
  await tx
    .update(bookingVerifications)
    .set({ waitlistEntryId: Id.parse(entryId) })
    .where(eq(bookingVerifications.id, BookingRequestIdSchema.parse(id)));
}

/**
 * How many requests for this email have a code expiring after `after` (a rate limit: every
 * code lives equally long, so this counts the requests made since `after` minus that time).
 */
export async function countBookingVerificationsExpiringAfter(
  tx: TenantTx,
  email: string,
  after: Date,
): Promise<number> {
  const [row] = await tx
    .select({ value: count() })
    .from(bookingVerifications)
    .where(
      and(
        eq(bookingVerifications.email, ClientEmailSchema.parse(email)),
        gt(bookingVerifications.expiresAt, after),
      ),
    );
  return row?.value ?? 0;
}

/**
 * The booking a link token's hash opens: its confirmation's (`manage_token_hash`), or a
 * reminder's (S62, `booking_manage_links`).
 */
function opensBooking(tokenHash: string) {
  const hash = HashSchema.parse(tokenHash);
  return or(
    eq(bookings.manageTokenHash, hash),
    sql`${bookings.id} IN (SELECT booking_id FROM booking_manage_links WHERE token_hash = ${hash})`,
  );
}

/** The booking whose link token has this hash, locked until the transaction ends. */
export async function lockBookingByManageTokenHash(
  tx: TenantTx,
  tokenHash: string,
): Promise<BookingRow | undefined> {
  const [row] = await tx.select().from(bookings).where(opensBooking(tokenHash)).for('update');
  return row;
}

/** The booking whose link token has this hash. */
export async function findBookingByManageTokenHash(
  tx: TenantTx,
  tokenHash: string,
): Promise<BookingRow | undefined> {
  const [row] = await tx.select().from(bookings).where(opensBooking(tokenHash));
  return row;
}
