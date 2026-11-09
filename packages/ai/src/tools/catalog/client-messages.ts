import {
  emailDetailsOf,
  formatWhen,
  getBookingIn,
  reminderEmail,
  type BookingEmailDetails,
} from '@pepper/appointments';
import {
  aiDisclosureLines,
  BookingIdSchema,
  looksLikeContact,
  looksLikeLink,
  type TrustJson,
} from '@pepper/contracts';
import {
  ClientMessageNotSendableError,
  DraftRefusedError,
  requirePermission,
  type EmailMessage,
} from '@pepper/core';
import { findBooking, findCurrentTenant } from '@pepper/db';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { clientFirstName } from '../names.js';
import type { Performed, WriteTool } from '../tool.js';
import { checkNoSensitiveValue } from './nudges.js';
import { IdArg } from './shared.js';

// One email the member asks for, to one client about one of their visits (S56a, ADR-0060): a
// reminder, "running late" or the member's own short note. The domain writes the reminder and
// the running-late words; a note is the member's, checked at every run (no link, no contact, no
// sensitive remembered value). Transactional (about a booking), so no marketing footer and a
// marketing opt-out doesn't stop it. Its dial action is `message.client` (asks by default);
// Undo takes the email back until it leaves. A note's words come through the chat, so the model
// may have put them its own way: it says so above the business's name, with a link to the
// privacy policy's AI section (S59.5, ADR-0064, AC-X-55); the domain's own words don't.

/** A note is a text-length message, the card shows it whole. */
export const CLIENT_NOTE_MAX = 200;
/** "Running late" goes from this long before the start… */
const LATE_FROM_MINUTES_BEFORE = 180;
/** …until this long after it. */
const LATE_UNTIL_MINUTES_AFTER = 60;
const MINUTE_MS = 60_000;

export const MessageKindSchema = z.enum(['reminder', 'running_late', 'note']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

const MessageArgs = z.strictObject({
  bookingId: IdArg('booking').describe(
    "The visit the message is about: its id from find_client_bookings (or get_day). Every message is about one of the client's visits.",
  ),
  kind: MessageKindSchema.describe(
    'reminder: their visit is coming up; running_late: the member or staff member is running late for it; note: anything else the member asked to tell them, in `note`',
  ),
  minutesLate: z
    .number()
    .int()
    .min(5)
    .max(60)
    .nullable()
    .describe('With running_late: how many minutes late, as the member said (5–60); else null'),
  note: z
    .string()
    .max(CLIENT_NOTE_MAX * 2)
    .nullable()
    .describe(
      `With note: the member's message in their words, at most ${String(CLIENT_NOTE_MAX)} characters, no links or contact details; else null`,
    ),
});
type MessageArgs = z.output<typeof MessageArgs>;

/** Whether a message of this kind may go now about a visit starting `startsAt` (AC-W2-6). */
export function messageTiming(
  kind: MessageKind,
  startsAt: Date,
  now: Date,
): 'ok' | 'started' | 'too_early' | 'too_late' {
  const start = startsAt.getTime();
  const at = now.getTime();
  if (kind === 'reminder') return at < start ? 'ok' : 'started';
  if (kind === 'running_late') {
    if (at < start - LATE_FROM_MINUTES_BEFORE * MINUTE_MS) return 'too_early';
    if (at > start + LATE_UNTIL_MINUTES_AFTER * MINUTE_MS) return 'too_late';
  }
  return 'ok';
}

/** A note as it is sent: spaces tidied; refused with a link, a contact or too long. */
export function cleanNote(note: string | null): string {
  const text = (note ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text === '') throw new DraftRefusedError('invalid', 'The note is empty');
  if (text.length > CLIENT_NOTE_MAX) throw new DraftRefusedError('invalid', 'The note is too long');
  if (looksLikeLink(text) || looksLikeContact(text)) {
    throw new DraftRefusedError('invalid', 'Leave links and contact details out');
  }
  return text;
}

function localTime(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(startsAt),
  );
}

/** The email for one message, in the business's words (AC-W2-5). */
export function clientMessageEmail(
  details: BookingEmailDetails,
  message:
    | { kind: 'reminder' }
    | { kind: 'running_late'; minutes: number; today: boolean }
    | {
        kind: 'note';
        note: string;
        /** The AI disclosure's lines (`aiDisclosureLines`). */
        disclosure: readonly string[];
      },
): EmailMessage {
  const firstName = clientFirstName(details.clientName) ?? 'there';
  const service = details.serviceName.toLowerCase();
  if (message.kind === 'reminder') return reminderEmail({ ...details, clientName: firstName });
  if (message.kind === 'running_late') {
    const who = details.staffName ?? `${details.businessName}'s team`;
    const at = message.today
      ? `${localTime(details.startsAt, details.timeZone)} today`
      : formatWhen(details.startsAt, details.timeZone);
    return {
      to: details.email,
      subject: `Running about ${String(message.minutes)} minutes late`,
      text: [
        `Hi ${firstName},`,
        '',
        `${who} is running about ${String(message.minutes)} minutes late for your ${service} at ${at}. Sorry for the wait, see you soon.`,
        '',
        details.businessName,
      ].join('\n'),
    };
  }
  return {
    to: details.email,
    subject: `A note from ${details.businessName}`,
    text: [
      `Hi ${firstName},`,
      '',
      message.note,
      '',
      `About your ${service}, ${formatWhen(details.startsAt, details.timeZone)}.`,
      '',
      ...message.disclosure,
      '',
      details.businessName,
    ].join('\n'),
  };
}

/** The words that identify a message, for its dedupe key: a retry never sends twice. */
function wordsKey(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 16);
}

export const sendClientMessage: WriteTool = {
  kind: 'write',
  name: 'send_client_message',
  // 2 (S59.5): a note carries the AI disclosure; a proposal from before expires rather than
  // sending an email its card didn't show.
  version: 2,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: "Email one client about one of their visits: a reminder, that the member (or a staff member) is running late, or a short note in the member's words.",
    avoid: [
      'to confirm, move or cancel a booking (those tools email the client themselves)',
      'to message several clients, or a client about no visit (say you can’t do that yet)',
      'for offers or marketing (the morning suggestions draft those)',
    ],
    returns: 'the email, waiting for the member’s OK unless their settings say otherwise.',
    examples: [
      // The eval world's Maria is booked Tuesday 15:00 and Ana Friday 14:00, its clock Monday
      // 07:00: "running late" moves to an hour before Maria's visit.
      {
        say: "Tell Maria I'm running 10 minutes late",
        evalLater: 1860,
        args: { bookingId: { $any: true }, kind: 'running_late', minutesLate: 10 },
      },
      {
        say: 'Remind Ana about her appointment tomorrow',
        evalSay: 'Remind Ana about her appointment on Friday',
        args: { bookingId: { $any: true }, kind: 'reminder' },
      },
      {
        say: 'Let Sara know to bring her inspiration photos to her appointment tomorrow',
        evalSay: 'Let Maria know to bring her inspiration photos to her appointment tomorrow',
        args: { bookingId: { $any: true }, kind: 'note', note: { $regex: 'photo' } },
      },
    ],
  },
  args: MessageArgs,
  actions: () => ['message.client'],
  async perform(scope, raw): Promise<Performed> {
    const args = MessageArgs.parse(raw);
    requirePermission(scope.actor, 'bookings.manage');
    // The visit as the member may see it: staff reach only their own.
    const booking = await getBookingIn(
      scope.tx,
      scope.actor,
      BookingIdSchema.parse(args.bookingId),
    );
    const row = await findBooking(scope.tx, booking.id);
    if (row === undefined) throw new ClientMessageNotSendableError('not_booked');
    if (row.status !== 'confirmed') throw new ClientMessageNotSendableError('not_booked');
    const timing = messageTiming(args.kind, row.startsAt, scope.now);
    if (timing !== 'ok') throw new ClientMessageNotSendableError(timing);
    if (args.kind === 'running_late' && args.minutesLate === null) {
      throw new DraftRefusedError('invalid', 'Say how many minutes late');
    }
    const note = args.kind === 'note' ? cleanNote(args.note) : null;
    const clientId = booking.clientId;
    if (note !== null) {
      await checkNoSensitiveValue(scope, clientId, { subject: '', body: note });
    }

    const tenant = await findCurrentTenant(scope.tx);
    if (tenant === undefined) throw new Error('No business in this transaction');
    const details = await emailDetailsOf(scope.tx, tenant, row);
    if (details.email === '') throw new ClientMessageNotSendableError('no_email');
    const start = localOf(scope.timeZone, row.startsAt);
    const end = localOf(scope.timeZone, row.endsAt);
    const minutes = args.minutesLate ?? 0;
    const email = clientMessageEmail(
      details,
      args.kind === 'running_late'
        ? {
            kind: 'running_late',
            minutes,
            today: start.date === localOf(scope.timeZone, scope.now).date,
          }
        : note !== null
          ? {
              kind: 'note',
              note,
              disclosure: aiDisclosureLines(details.businessName, scope.deps.emails.baseUrl),
            }
          : { kind: 'reminder' },
    );
    await scope.emailClient({
      clientId,
      template: 'client_message',
      // The minute it was asked for too: the same words asked again later (after an Undo, or the
      // next day) are a new message, never dropped as a duplicate.
      dedupeKey: `client.message:${row.id}:${args.kind}:${wordsKey(`${scope.now.toISOString().slice(0, 16)}\n${email.text}`)}`,
      message: { to: email.to, subject: email.subject, text: email.text },
    });

    const firstName = clientFirstName(details.clientName) ?? 'the client';
    const shown =
      args.kind === 'running_late'
        ? `Running about ${String(minutes)} minutes late.`
        : args.kind === 'note'
          ? (note ?? '')
          : 'A reminder of the visit.';
    return {
      entity: { type: 'booking', id: row.id },
      // One pending message per visit and kind.
      targetKey: `message:${row.id}:${args.kind}`,
      recordOwner: null,
      appointmentStartsAt: null,
      before: null,
      after: {
        clientName: firstName,
        kind: args.kind,
        date: start.date,
        time: start.time,
        endTime: end.time,
        message: shown,
      },
      touched: { bookingUpdatedAt: row.updatedAt.toISOString() },
      // Undo is taking the email back (until it leaves); nothing else changed.
      inverse: {} satisfies TrustJson,
      summary:
        args.kind === 'running_late'
          ? `Tell ${firstName} you're running about ${String(minutes)} minutes late for their ${details.serviceName.toLowerCase()}.`
          : args.kind === 'note'
            ? `Email ${firstName} your note about their ${details.serviceName.toLowerCase()}.`
            : `Remind ${firstName} of their ${details.serviceName.toLowerCase()}.`,
      facts: [{ kind: 'message_visit', ref: null, value: { date: start.date, time: start.time } }],
      // A client's own name came from outside the team (the booking page), and so may a note's
      // words be echoed later.
      untrustedText: true,
    };
  },
  undo(): Promise<void> {
    // The trust layer takes the email back; there is nothing else to reverse.
    return Promise.resolve();
  },
};
