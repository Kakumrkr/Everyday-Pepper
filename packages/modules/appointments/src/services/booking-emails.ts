import {
  BookingIdSchema,
  ClientIdSchema,
  OutboxDedupeKeySchema,
  type OutboxMessageId,
  type WaitlistOfferId,
} from '@pepper/contracts';
import { queueEmail, queueSms, systemClock, type Clock, type EmailMessage } from '@pepper/core';
import { findBooking, findCurrentTenant, insertBookingText, type TenantTx } from '@pepper/db';
import {
  cancelledEmail,
  confirmationEmail,
  manageUrl,
  rescheduledEmail,
  waitlistTakenEmail,
} from '../emails.js';
import { confirmationText, optInText } from '../texts.js';
import type { BookingEmailDetails, BookingNotice } from './notices.js';
import { reminderSettingsOf, textableNumber } from './reminders.js';

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
  /** Whether this deployment sends texts (`SMS_PROVIDER` set, ADR-0065); default no. */
  texts?: boolean;
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

/**
 * Queues the text about a confirmed booking (S62, AC-X-73), beside its email: the opt-in
 * confirmation when the client just said yes on the booking page (`newSmsConsent`), else a
 * short confirmation when their texts are already on. To the number on their consent in force,
 * only when the business may text it and texts are on. Moves and cancellations are told by
 * email. Returns the message id, or `undefined` when no text goes (or it was queued already).
 */
export async function queueBookingText(
  tx: TenantTx,
  notice: BookingNotice,
  options: BookingEmailOptions,
): Promise<OutboxMessageId | undefined> {
  if (notice.kind !== 'confirmed' || options.texts !== true) return undefined;
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined || !reminderSettingsOf(tenant).texts) return undefined;
  const bookingId = BookingIdSchema.parse(notice.change.bookingId);
  const booking = await findBooking(tx, bookingId);
  if (booking === undefined) return undefined;
  const clientId = ClientIdSchema.parse(booking.clientId);
  const phone = await textableNumber(tx, clientId);
  if (phone === null) return undefined;
  const optIn = notice.newSmsConsent === true;
  const link = manageUrl(options.baseUrl, notice.email.slug, notice.manageToken);
  const now = (options.clock ?? systemClock).now();
  const id = await queueSms(
    tx,
    {
      to: phone,
      body: optIn ? optInText(notice.email, link) : confirmationText(notice.email, link),
      wordsBy: 'template',
    },
    {
      key: options.outboxKey,
      // One a booking and change (the same `at` as its email's key).
      dedupeKey: OutboxDedupeKeySchema.parse(
        `booking.${optIn ? 'opt_in' : 'confirmed'}.sms:${bookingId}:${String(notice.change.at.getTime())}`,
      ),
      now,
    },
  );
  if (id === undefined) return undefined;
  await insertBookingText(tx, {
    id,
    clientId,
    bookingId,
    kind: optIn ? 'opt_in' : 'confirmation',
    startsAt: booking.startsAt,
    createdAt: now,
  });
  return id;
}

/** A client whose waitlist offer someone else claimed first (or whose time went meanwhile). */
export interface WaitlistTakenNotice {
  email: BookingEmailDetails;
  offerId: WaitlistOfferId;
}

/** Receives a "taken" notice inside the claim's transaction. */
export type WaitlistTakenNotify = (tx: TenantTx, notice: WaitlistTakenNotice) => Promise<void>;

/** Queues the "taken" email: one per offer, whatever retries. */
export async function queueWaitlistTakenEmail(
  tx: TenantTx,
  notice: WaitlistTakenNotice,
  options: BookingEmailOptions,
): Promise<OutboxMessageId | undefined> {
  if (notice.email.email === '') return undefined;
  return queueEmail(tx, waitlistTakenEmail(notice.email), {
    key: options.outboxKey,
    dedupeKey: OutboxDedupeKeySchema.parse(`waitlist.taken:${notice.offerId}`),
    now: (options.clock ?? systemClock).now(),
  });
}
