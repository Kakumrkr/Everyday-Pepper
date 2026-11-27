import { createHash, randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  cancellationSentence,
  CancellationFeesSchema,
  ClientIdSchema,
  CONFIRM_CUTOFF_HOURS,
  ManageTokenSchema,
  reminderSettingsFrom,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type BookingId,
  type ManageToken,
  type PublicBookingDeposit,
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
  /** The business's cancellation policy (S67.2, AC-X-133): Pepper's sentence and its note. */
  policy: CancellationPolicyWords;
  /** The deposit just paid, for the confirmation only (S67.2 top-up, AC-X-134). */
  deposit?: PublicBookingDeposit | null;
  /**
   * When the client should confirm by (S78, AC-X-202): set while the business asks clients to
   * confirm and this client hasn't; the email then asks for it with the link.
   */
  confirmBy?: string | null;
}

/**
 * When the client of `row` is asked to confirm by (`CONFIRM_CUTOFF_HOURS` before the start),
 * or `null`: the business doesn't ask, or the client already confirmed.
 */
export function confirmByOf(
  tenant: Pick<Tenant, 'reminderSettings'>,
  row: Pick<BookingRow, 'startsAt' | 'clientConfirmedAt'>,
): string | null {
  if (!reminderSettingsFrom(tenant.reminderSettings).askToConfirm) return null;
  if (row.clientConfirmedAt !== null) return null;
  return new Date(row.startsAt.getTime() - CONFIRM_CUTOFF_HOURS * 3_600_000).toISOString();
}

/** The cancellation policy in words: Pepper's sentence and the owner's note; `null`: none. */
export interface CancellationPolicyWords {
  sentence: string | null;
  note: string | null;
}

/**
 * The business's policy in Pepper's sentence (S67.2, AC-X-131); `null` without one. A stored
 * value the contract no longer takes reads as no policy, so a page or an email never fails.
 */
export function cancellationSentenceOf(
  tenant: Pick<Tenant, 'cancellationFees' | 'depositRefundHours'>,
): string | null {
  const fees = CancellationFeesSchema.nullable().catch(null).parse(tenant.cancellationFees);
  return cancellationSentence(fees, tenant.depositRefundHours);
}

/** The policy the emails carry (AC-X-133). */
export function policyWordsOf(
  tenant: Pick<Tenant, 'cancellationFees' | 'depositRefundHours' | 'cancellationPolicy'>,
): CancellationPolicyWords {
  return { sentence: cancellationSentenceOf(tenant), note: tenant.cancellationPolicy };
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
    policy: policyWordsOf(tenant),
    confirmBy: confirmByOf(tenant, row),
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
