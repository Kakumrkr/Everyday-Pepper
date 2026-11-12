import { createHash, randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  ClientIdSchema,
  ManageTokenSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type BookingId,
  type ManageToken,
} from '@pepper/contracts';
import {
  findClient,
  findService,
  findStaffMember,
  type BookingRow,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import { BookingNotFoundError } from '../errors.js';

// What a booking's client is told by email (W6, ADR-0024, ADR-0025): the booking services call
// the caller's `notify` inside the change's transaction with a notice, so an email the caller
// queues in the outbox commits with the change, or not at all. Team-made and booking-page
// bookings use the same notices; the reminder job renders its own from the same details.

/** Details of the business and booking for the email the caller sends. */
export interface BookingEmailDetails {
  businessName: string;
  /** The business's booking page, for the client's reschedule/cancel link. */
  slug: string;
  timeZone: string;
  serviceName: string;
  staffName: string | null;
  startsAt: string;
  email: string;
  clientName: string;
}

/** A change of a booking that its client is told about by email. */
export type BookingNotice =
  | {
      kind: 'confirmed';
      email: BookingEmailDetails;
      manageToken: ManageToken;
      change: BookingChange;
      /** The client just said yes to texts on the booking page (S62: the opt-in text). */
      newSmsConsent?: true;
    }
  | {
      kind: 'rescheduled';
      email: BookingEmailDetails;
      manageToken: ManageToken;
      change: BookingChange;
    }
  | { kind: 'cancelled'; email: BookingEmailDetails; change: BookingChange };

/** Which booking changed, and when (the row's `updated_at`: one value per change). */
export interface BookingChange {
  bookingId: BookingId;
  at: Date;
}

/** Receives a notice inside the change's transaction. */
export type BookingNotify = (tx: TenantTx, notice: BookingNotice) => Promise<void>;

export function changeOf(row: BookingRow): BookingChange {
  return { bookingId: BookingIdSchema.parse(row.id), at: row.updatedAt };
}

/**
 * The email details of a booking: its service and staff member as they are now, and its
 * client's current address (empty when the business has none on file).
 */
export async function emailDetailsOf(
  tx: TenantTx,
  tenant: Tenant,
  row: BookingRow,
): Promise<BookingEmailDetails> {
  const service = await findService(tx, ServiceIdSchema.parse(row.serviceId));
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(row.staffMemberId));
  const client = await findClient(tx, ClientIdSchema.parse(row.clientId));
  // Bookings reference all three with foreign keys, and none is ever deleted.
  if (service === undefined || staff === undefined || client === undefined) {
    throw new BookingNotFoundError();
  }
  return {
    businessName: tenant.name,
    slug: tenant.slug,
    timeZone: tenant.timeZone,
    serviceName: service.name,
    staffName: staff.displayName,
    startsAt: row.startsAt.toISOString(),
    email: client.email ?? '',
    clientName: client.name,
  };
}

/** A new secret for a booking's reschedule/cancel link, and the hash that is stored. */
export function newManageToken(): { token: ManageToken; hash: string } {
  const token = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
  return { token, hash: manageTokenHash(token) };
}

/** SHA-256 (hex) of a link token: 256 random bits need no key or slow hash (as invites). */
export function manageTokenHash(token: ManageToken): string {
  return createHash('sha256').update(ManageTokenSchema.parse(token)).digest('hex');
}
