import { smsPlainText, smsReplySender, type ClientReminderKind } from '@pepper/contracts';
import type { BookingEmailDetails } from './services/notices.js';

// The texts to a booking's client (S62, ADR-0065): Pepper's fixed words (`wordsBy: template`),
// from "{business} via Pepper", in the business's time zone, every typed name in GSM-7 and cut,
// so each text stays within three GSM-7 segments whatever the names. Dates are always written
// out ("Tue, Nov 17"), never "tomorrow": a text may wait for the quiet hours.

/** The longest service and staff names a text carries before they are shortened. */
export const TEXT_SERVICE_MAX = 40;
export const TEXT_STAFF_MAX = 30;

/** "Tue, Nov 17 at 2:00 PM" in the business's time zone. */
export function formatTextWhen(startsAt: string, timeZone: string): string {
  const instant = new Date(startsAt);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant);
  return `${day} at ${formatTextTime(startsAt, timeZone)}`;
}

/** "2:00 PM" in the business's time zone (a narrow space before PM made a plain one). */
export function formatTextTime(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(startsAt))
    .replace(/\s/g, ' ');
}

function sender(details: BookingEmailDetails): string {
  return smsReplySender([details.businessName]);
}

/** "Haircut with Jess": the service and staff member, in GSM-7 and cut. */
function serviceWith(details: BookingEmailDetails): string {
  const service = serviceOnly(details, TEXT_SERVICE_MAX);
  const staff = details.staffName === null ? '' : smsPlainText(details.staffName, TEXT_STAFF_MAX);
  return staff === '' ? service : `${service} with ${staff}`;
}

function serviceOnly(details: BookingEmailDetails, max: number): string {
  return smsPlainText(details.serviceName, max) || 'your appointment';
}

/** The opt-in text's service: shorter, and without the staff member, for its required words. */
export const OPT_IN_SERVICE_MAX = 30;

export interface ReminderTextInput {
  kind: ClientReminderKind;
  details: BookingEmailDetails;
  /** The reminder's reschedule/cancel link; `null` without the app's address. */
  link: string | null;
  /** Ask "Reply C to confirm" (until the client has). */
  askToConfirm: boolean;
  /** The client's first reminder text from the business: say how to stop (S62 top-up). */
  first: boolean;
  /** A same-day text that goes on the day of the visit says "today". */
  today: boolean;
}

/** "Reply C to confirm." The early ask says by when, and why (S78, AC-X-204). */
function confirmAsk(input: ReminderTextInput): string {
  const by = input.details.confirmBy;
  if (input.kind !== 'confirm_ask' || by === undefined || by === null) return 'Reply C to confirm.';
  return `Reply C by ${formatTextWhen(by, input.details.timeZone)}, or your time may be offered to others.`;
}

/** A reminder text (AC-X-72; the confirm ask, S78). */
export function reminderText(input: ReminderTextInput): string {
  const { details } = input;
  const opening =
    input.kind === 'confirm_ask'
      ? `Please confirm ${serviceWith(details)} on ${formatTextWhen(details.startsAt, details.timeZone)}.`
      : input.kind === 'same_day' && input.today
        ? `See you today at ${formatTextTime(details.startsAt, details.timeZone)} for ${serviceWith(details)}.`
        : input.kind === 'same_day'
          ? `See you ${formatTextWhen(details.startsAt, details.timeZone)} for ${serviceWith(details)}.`
          : `Reminder: ${serviceWith(details)} on ${formatTextWhen(details.startsAt, details.timeZone)}.`;
  const lines = [
    [
      `${sender(details)}: ${opening}`,
      input.askToConfirm ? confirmAsk(input) : null,
      input.link === null ? null : `Change or cancel: ${input.link}`,
    ]
      .filter((part) => part !== null)
      .join(' '),
  ];
  if (input.first) lines.push('Reply STOP to opt out.');
  return lines.join('\n');
}

/**
 * The opt-in confirmation (AC-X-73), the first text after a new consent, with the booking: who
 * texts, what, how often, rates, HELP and STOP (the carriers' recommended first message).
 */
export function optInText(details: BookingEmailDetails, link: string | null): string {
  return [
    `${sender(details)}: You're booked: ${serviceOnly(details, OPT_IN_SERVICE_MAX)} on ${formatTextWhen(details.startsAt, details.timeZone)}.`,
    link === null ? null : `Change or cancel: ${link}`,
    "You'll get appointment confirmations and reminders here. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.",
  ]
    .filter((part) => part !== null)
    .join('\n');
}

/** A booking's confirmation for a client whose texts are already on (AC-X-73). */
export function confirmationText(details: BookingEmailDetails, link: string | null): string {
  return [
    `${sender(details)}: You're booked: ${serviceWith(details)} on ${formatTextWhen(details.startsAt, details.timeZone)}.`,
    link === null ? null : `Change or cancel: ${link}`,
  ]
    .filter((part) => part !== null)
    .join(' ');
}

/** The answer to a client's "C" (AC-X-74). */
export function confirmedReply(details: BookingEmailDetails, already: boolean): string {
  const when = formatTextWhen(details.startsAt, details.timeZone);
  return already
    ? `${sender(details)}: You're already confirmed for ${serviceWith(details)} on ${when}. See you then!`
    : `${sender(details)}: Thanks, you're confirmed for ${serviceWith(details)} on ${when}. See you then!`;
}

/** The answer to a "C" that confirms nothing (AC-X-74). */
export const NOTHING_TO_CONFIRM_REPLY =
  "Pepper: We couldn't find an upcoming appointment to confirm for this number. Please contact the business directly. Reply HELP for help.";

/**
 * How long an offer stays open (S79 top-up, AC-X-227): "2 hours", "1 hour 30 minutes",
 * "45 minutes" (whole minutes, rounded down; at least 1).
 */
export function openForLabel(ms: number): string {
  const total = Math.max(1, Math.floor(ms / 60_000));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const unit = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`;
  if (hours === 0) return unit(minutes, 'minute');
  return minutes === 0 ? unit(hours, 'hour') : `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`;
}

/** "Open for 2 hours, until 3:15 PM": from `from` (when the client reads it) to the close. */
export function offerOpenLine(from: number, expiresAt: string, timeZone: string): string {
  return `Open for ${openForLabel(Date.parse(expiresAt) - from)}, until ${formatTextTime(expiresAt, timeZone)}.`;
}

/**
 * A freed time offered to a waitlist client by text (S79, AC-X-224): the time, how long it is
 * open from when the text goes (`sendAt`, after the quiet hours), and the claim link.
 */
export function waitlistOfferText(
  details: BookingEmailDetails,
  claimUrl: string,
  expiresAt: string,
  sendAt: number,
): string {
  return [
    `${sender(details)}: A time you're waiting for opened up: ${serviceWith(details)} on ${formatTextWhen(details.startsAt, details.timeZone)}.`,
    `${offerOpenLine(sendAt, expiresAt, details.timeZone)} First to claim it gets it: ${claimUrl}`,
    'Reply STOP to opt out.',
  ].join('\n');
}

/**
 * The first text after a waitlist client's yes (S79, AC-X-223): who texts, what about, how
 * often, rates, HELP and STOP (the carriers' recommended first message).
 */
export function waitlistOptInText(
  details: Pick<BookingEmailDetails, 'businessName' | 'serviceName'>,
): string {
  return [
    `${smsReplySender([details.businessName])}: You're on the waitlist for ${smsPlainText(details.serviceName, OPT_IN_SERVICE_MAX) || 'your appointment'}. We'll text you when a time you're waiting for opens up.`,
    'Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.',
  ].join('\n');
}
