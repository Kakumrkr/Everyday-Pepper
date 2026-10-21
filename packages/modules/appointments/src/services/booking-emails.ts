import { OutboxDedupeKeySchema, type OutboxMessageId } from '@pepper/contracts';
import { queueEmail, systemClock, type Clock, type EmailMessage } from '@pepper/core';
import type { TenantTx } from '@pepper/db';
import { cancelledEmail, confirmationEmail, manageUrl, rescheduledEmail } from '../emails.js';
import type { BookingNotice } from './notices.js';

// The emails a booking's client gets when it is confirmed, moved or cancelled, from the booking
// page, the team or the AI (ADR-0024, ADR-0025, ADR-0029): queued in the outbox inside the
// change's transaction, so the worker sends each exactly once, or never if the change rolls
// back. The AI's emails are held for the "undo send" grace (ADR-0028), so Undo can take them
// back before they leave.

export interface BookingEmailOptions {
  /** The web app's origin, for the client's reschedule/cancel link. */
  baseUrl: string;
  /** Seals the emails queued in the outbox (ADR-0024). */
  outboxKey: Buffer;
  clock?: Clock;
  /** Seconds the email waits before it may be sent (the AI's: `AI_EMAIL_GRACE_SECONDS`). */
  holdSeconds?: number;
}

/**
 * Queues the email about a change. Returns its outbox id, or `undefined` when the client has no
 * email address or this change's email was already queued.
 */
export async function queueBookingEmail(
  tx: TenantTx,
  notice: BookingNotice,
  options: BookingEmailOptions,
): Promise<OutboxMessageId | undefined> {
  if (notice.email.email === '') return undefined;
  const link = (token: string) => manageUrl(options.baseUrl, notice.email.slug, token);
  const message: EmailMessage =
    notice.kind === 'cancelled'
      ? cancelledEmail(notice.email)
      : notice.kind === 'confirmed'
        ? confirmationEmail(notice.email, link(notice.manageToken))
        : rescheduledEmail(notice.email, link(notice.manageToken));
  // One email per change: `at` is the booking's `updated_at`, one value per transaction.
  const { bookingId, at } = notice.change;
  const now = (options.clock ?? systemClock).now().getTime();
  return queueEmail(tx, message, {
    key: options.outboxKey,
    dedupeKey: OutboxDedupeKeySchema.parse(
      `booking.${notice.kind}:${bookingId}:${String(at.getTime())}`,
    ),
    now: new Date(now + (options.holdSeconds ?? 0) * 1000),
  });
}
