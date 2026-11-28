import { BookingIdSchema, SmsPhoneSchema, type BookingId } from '@pepper/contracts';
import {
  appendAuditEntry,
  findCurrentTenant,
  hasRecentReminderText,
  isSmsOptedOut,
  lockBooking,
  markBookingClientConfirmed,
  smsConfirmTarget,
  withTenant,
  type BookingRow,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { confirmedReply, NOTHING_TO_CONFIRM_REPLY } from '../texts.js';
import { requestInsights } from './insights.js';
import { keepReleaseCardInStep, lockReleaseCard } from './release-check.js';
import { emailDetailsOf } from './notices.js';

// "C" to confirm (S62, ADR-0065, AC-X-74). A client's reply reaches Pepper's one number with no
// business in it, after the webhook's signature check. `sms_confirm_target` answers which
// booking it confirms (ids only): the soonest upcoming one whose reminder went to that number
// in the last 48 hours. That business's transaction checks the booking again under its lock,
// marks it confirmed by the client once (audited as the system) and answers with its time.

/** What a "C" did, and the reply to send back (`null`: none, the number opted out). */
export interface ConfirmByTextResult {
  outcome: 'confirmed' | 'already' | 'nothing';
  reply: string | null;
}

export async function confirmBookingByText(
  db: Database,
  input: { from: string; receivedAt: Date },
): Promise<ConfirmByTextResult> {
  const from = SmsPhoneSchema.safeParse(input.from);
  if (!from.success) return { outcome: 'nothing', reply: null };
  // After a STOP Pepper sends nothing but the STOP's own answer, so a "C" is kept, unanswered.
  const optedOut = await isSmsOptedOut(db, from.data);
  const answer = (result: ConfirmByTextResult): ConfirmByTextResult =>
    optedOut ? { ...result, reply: null } : result;
  const target = await smsConfirmTarget(db, from.data, input.receivedAt);
  if (target === undefined) return answer({ outcome: 'nothing', reply: NOTHING_TO_CONFIRM_REPLY });
  return withTenant(db, target.tenantId, async (tx) => {
    const bookingId = BookingIdSchema.parse(target.bookingId);
    // The visit's release card first, then the visit: an approval's order (S78.2, AC-X-210).
    await lockReleaseCard(tx, bookingId);
    const booking = await lockBooking(tx, bookingId);
    const tenant = await findCurrentTenant(tx);
    // Changed between the lookup and the lock (cancelled, started or moved off the reminded time).
    if (
      booking === undefined ||
      tenant === undefined ||
      booking.status !== 'confirmed' ||
      booking.startsAt.getTime() <= input.receivedAt.getTime() ||
      !(await hasRecentReminderText(tx, {
        bookingId,
        startsAt: booking.startsAt,
        at: input.receivedAt,
      }))
    ) {
      return answer({ outcome: 'nothing', reply: NOTHING_TO_CONFIRM_REPLY });
    }
    const marked = await markClientConfirmedIn(tx, bookingId, input.receivedAt, null);
    const details = await emailDetailsOf(tx, tenant, booking);
    const already = !marked;
    return answer({
      outcome: already ? 'already' : 'confirmed',
      reply: confirmedReply(details, already),
    });
  });
}

/**
 * Marks a locked, coming visit confirmed by its client once (audited as the system, with `via`
 * when it wasn't a "C"); whether it changed. The visit's risk is rescored and its release card
 * goes (S77, S78.2).
 */
async function markClientConfirmedIn(
  tx: TenantTx,
  bookingId: BookingId,
  at: Date,
  via: 'text_read' | null,
): Promise<boolean> {
  const marked = await markBookingClientConfirmed(tx, bookingId, at);
  if (marked === undefined) return false;
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'booking.client_confirmed',
      entity: { type: 'booking', id: bookingId },
      before: { clientConfirmed: false },
      after: via === null ? { clientConfirmed: true } : { clientConfirmed: true, via },
    },
  });
  // A confirmed visit's risk drops (S77): the next insights pass rescores it.
  await requestInsights(tx);
  // A release card waiting for this visit goes (S78.2, AC-X-210).
  await keepReleaseCardInStep(tx, marked, at.getTime());
  return true;
}

/** What confirming a visit by its id did (S81a.2): `nothing` when it isn't the client's coming visit. */
export type ConfirmByIdOutcome = 'confirmed' | 'already' | 'nothing';

/**
 * Confirms a visit by its id for its client (S81a.2, ADR-0073; AC-X-243), in the business's
 * transaction: a sure reading of the client's own text named it, from the visits the reader was
 * given. No reminder is needed, but the visit must still be that client's, booked and to come,
 * under its lock (release card first, as an approval). Audited as the system, `via: text_read`.
 */
export async function confirmClientVisitIn(
  tx: TenantTx,
  input: { bookingId: BookingId; clientId: string; at: Date },
): Promise<{ outcome: ConfirmByIdOutcome; booking: BookingRow | undefined }> {
  const bookingId = BookingIdSchema.parse(input.bookingId);
  await lockReleaseCard(tx, bookingId);
  const booking = await lockBooking(tx, bookingId);
  if (
    booking?.clientId !== input.clientId ||
    booking.status !== 'confirmed' ||
    booking.startsAt.getTime() <= input.at.getTime()
  ) {
    return { outcome: 'nothing', booking };
  }
  const marked = await markClientConfirmedIn(tx, bookingId, input.at, 'text_read');
  return { outcome: marked ? 'confirmed' : 'already', booking };
}
