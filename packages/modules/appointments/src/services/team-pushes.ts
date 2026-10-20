import {
  BookingIdSchema,
  StaffMemberIdSchema,
  UserIdSchema,
  type OutboxMessageId,
  type UserId,
} from '@pepper/contracts';
import { leadUserIds, queuePushToMembers } from '@pepper/core';
import { findBooking, findStaffMember, type TenantTx } from '@pepper/db';
import { bookingPagePush } from '../pushes.js';
import type { BookingNotice } from './notices.js';

/**
 * Queues the team's push about a booking the client made, moved or cancelled on the booking
 * page (ADR-0026): to the booked staff member's devices (when linked to a login) and the
 * owners' and managers'. Runs inside the change's transaction (work without a user), next to
 * the client's email; one push per change and device. Returns the queued messages' ids.
 */
export async function queueBookingPagePush(
  tx: TenantTx,
  notice: BookingNotice,
  options: { key: Buffer; now: Date },
): Promise<OutboxMessageId[]> {
  const { bookingId, at } = notice.change;
  const booking = await findBooking(tx, BookingIdSchema.parse(bookingId));
  if (booking === undefined) return [];
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(booking.staffMemberId));
  const recipients: UserId[] = await leadUserIds(tx);
  const staffUser = staff?.userId ?? null;
  if (staffUser !== null) recipients.push(UserIdSchema.parse(staffUser));
  return queuePushToMembers(
    tx,
    recipients,
    bookingPagePush(notice.kind, notice.email, booking.id),
    {
      key: options.key,
      dedupeKey: `push.booking.${notice.kind}:${booking.id}:${String(at.getTime())}`,
      now: options.now,
    },
  );
}
