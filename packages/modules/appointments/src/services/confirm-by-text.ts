import { BookingIdSchema, SmsPhoneSchema } from '@pepper/contracts';
import {
  appendAuditEntry,
  findCurrentTenant,
  hasRecentReminderText,
  isSmsOptedOut,
  lockBooking,
  markBookingClientConfirmed,
  smsConfirmTarget,
  withTenant,
  type Database,
} from '@pepper/db';
import { confirmedReply, NOTHING_TO_CONFIRM_REPLY } from '../texts.js';
import { requestInsights } from './insights.js';
import { keepReleaseCardInStep } from './release-check.js';
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
    const marked = await markBookingClientConfirmed(tx, bookingId, input.receivedAt);
    if (marked !== undefined) {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'booking.client_confirmed',
          entity: { type: 'booking', id: bookingId },
          before: { clientConfirmed: false },
          after: { clientConfirmed: true },
        },
      });
      // A confirmed visit's risk drops (S77): the next insights pass rescores it.
      await requestInsights(tx);
      // A release card waiting for this visit goes (S78.2, AC-X-210).
      await keepReleaseCardInStep(tx, marked, input.receivedAt.getTime());
    }
    const details = await emailDetailsOf(tx, tenant, booking);
    const already = marked === undefined;
    return answer({
      outcome: already ? 'already' : 'confirmed',
      reply: confirmedReply(details, already),
    });
  });
}
