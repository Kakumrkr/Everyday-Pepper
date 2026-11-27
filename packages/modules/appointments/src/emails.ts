import { depositPaidLine } from '@pepper/contracts';
import type { EmailMessage } from '@pepper/core';
import type { BookingEmailDetails } from './services/notices.js';

// The emails to a booking's client (ADR-0022, ADR-0025): plain text, in the business's time
// zone. They carry only what the client typed or booked; the code and the link are secrets for
// this client. The api sends the booking page's and the team's; the worker sends reminders.

/** "Tuesday, November 3 at 10:00 AM" in the business's time zone. */
export function formatWhen(startsAt: string, timeZone: string): string {
  const instant = new Date(startsAt);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(instant);
  return `${day} at ${time}`;
}

function what(details: BookingEmailDetails): string {
  const staff = details.staffName === null ? '' : ` with ${details.staffName}`;
  return `${details.serviceName}${staff}, ${formatWhen(details.startsAt, details.timeZone)}`;
}

/**
 * The business's cancellation policy at the end of an email (S67.2, AC-X-133): Pepper's sentence,
 * then the owner's note; nothing when there is neither.
 */
function policyLines(details: BookingEmailDetails): string[] {
  const { sentence, note } = details.policy;
  if (sentence === null && note === null) return [];
  return [
    '',
    'Cancellation policy:',
    ...(sentence === null ? [] : [sentence]),
    ...(note === null ? [] : [note]),
  ];
}

/**
 * The deposit under the booking in its confirmation (S67.2 top-up, AC-X-134): the team sheet's
 * words for a paid one, or that a kept card costs nothing now; nothing without one.
 */
function depositLines(details: BookingEmailDetails): string[] {
  const deposit = details.deposit;
  if (deposit?.status !== 'held') return [];
  return deposit.kind === 'card'
    ? ['Card on file. Nothing is charged now.']
    : [depositPaidLine(deposit, details.timeZone)];
}

/**
 * The ask to confirm (S78, AC-X-202): "Please confirm by …" while the business asks and the
 * client hasn't confirmed; the link then confirms too.
 */
function confirmLines(details: BookingEmailDetails): string[] {
  if (details.confirmBy === undefined || details.confirmBy === null) return [];
  return [
    '',
    `Please confirm by ${formatWhen(details.confirmBy, details.timeZone)}, or your time may be offered to others.`,
  ];
}

/** What the link does: it confirms too while the client is asked to (S78). */
function linkIntro(details: BookingEmailDetails, again = false): string {
  const asked = details.confirmBy !== undefined && details.confirmBy !== null;
  if (again)
    return asked ? 'To confirm, change it again or cancel:' : 'To change it again or cancel:';
  return asked
    ? 'To confirm, reschedule or cancel, use this link (it is just for you, so keep it private):'
    : 'To reschedule or cancel, use this link (it is just for you, so keep it private):';
}

export function codeEmail(
  details: BookingEmailDetails,
  code: string,
  minutes: number,
): EmailMessage {
  return {
    to: details.email,
    subject: `${code} is your code for ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Your code to confirm your booking at ${details.businessName} is:`,
      '',
      `    ${code}`,
      '',
      `${what(details)}.`,
      '',
      `The code works for ${String(minutes)} minutes. Nothing is booked until you enter it.`,
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  };
}

/**
 * The code to join the waitlist (S38a): for a day, not a time, and nothing is added until it is
 * typed.
 */
export function waitlistCodeEmail(
  details: BookingEmailDetails,
  code: string,
  minutes: number,
): EmailMessage {
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: details.timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(details.startsAt));
  const staff = details.staffName === null ? '' : ` with ${details.staffName}`;
  return {
    to: details.email,
    subject: `${code} is your code for ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Your code to join the waitlist at ${details.businessName} is:`,
      '',
      `    ${code}`,
      '',
      `${details.serviceName}${staff}, any time on ${day}.`,
      '',
      `The code works for ${String(minutes)} minutes. You're not on the waitlist until you enter it.`,
      'If a time opens up, we email you a link to claim it. If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  };
}

export function confirmationEmail(details: BookingEmailDetails, manageUrl: string): EmailMessage {
  return {
    to: details.email,
    subject: `You're booked at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `You're booked at ${details.businessName}:`,
      `${what(details)}.`,
      ...depositLines(details),
      ...confirmLines(details),
      '',
      linkIntro(details),
      manageUrl,
      ...policyLines(details),
    ].join('\n'),
  };
}

/** "Haircut with Dre" (no time): the service of every visit of a series. */
function service(details: BookingEmailDetails): string {
  const staff = details.staffName === null ? '' : ` with ${details.staffName}`;
  return `${details.serviceName}${staff}`;
}

/**
 * A series' one confirmation (S72, D-4, AC-X-185): every booked visit, each with its own
 * reschedule/cancel link (each link changes that visit only).
 */
export function seriesConfirmationEmail(
  details: BookingEmailDetails,
  visits: readonly { startsAt: string; manageUrl: string }[],
): EmailMessage {
  return {
    to: details.email,
    subject: `You're booked at ${details.businessName}: ${String(visits.length)} visits`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `You're booked at ${details.businessName} for ${service(details)}, ${String(visits.length)} visits:`,
      ...visits.flatMap((visit) => [
        '',
        formatWhen(visit.startsAt, details.timeZone),
        `To reschedule or cancel this visit: ${visit.manageUrl}`,
      ]),
      '',
      'The links are just for you, so keep them private.',
      ...policyLines(details),
    ].join('\n'),
  };
}

/** The visits of a series the business cancelled ("this and following", AC-X-185). */
export function seriesCancelledEmail(
  details: BookingEmailDetails,
  visits: readonly { startsAt: string }[],
): EmailMessage {
  const one = visits.length === 1;
  return {
    to: details.email,
    subject: `${one ? 'A visit' : `${String(visits.length)} visits`} at ${details.businessName} ${one ? 'is' : 'are'} cancelled`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `${one ? 'This visit' : 'These visits'} at ${details.businessName} for ${service(details)} ${one ? 'is' : 'are'} cancelled:`,
      ...visits.map((visit) => formatWhen(visit.startsAt, details.timeZone)),
      '',
      'We hope to see you another time.',
      ...policyLines(details),
    ].join('\n'),
  };
}

export function rescheduledEmail(details: BookingEmailDetails, manageUrl: string): EmailMessage {
  return {
    to: details.email,
    subject: `Your booking at ${details.businessName} has moved`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Your booking at ${details.businessName} is now:`,
      `${what(details)}.`,
      ...confirmLines(details),
      '',
      linkIntro(details, true),
      manageUrl,
      ...policyLines(details),
    ].join('\n'),
  };
}

export function cancelledEmail(details: BookingEmailDetails): EmailMessage {
  return {
    to: details.email,
    subject: `Your booking at ${details.businessName} is cancelled`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Your booking at ${details.businessName} is cancelled:`,
      `${what(details)}.`,
      '',
      'We hope to see you another time.',
      ...policyLines(details),
    ].join('\n'),
  };
}

/**
 * The reminder a day before (AC-W6-1), with a reschedule/cancel link of its own (S62,
 * AC-X-72). Without the app's address (`link` null) it points to the confirmation's link.
 */
export function reminderEmail(
  details: BookingEmailDetails,
  link: string | null = null,
): EmailMessage {
  return {
    to: details.email,
    subject: `Reminder: your booking at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `This is a reminder of your booking at ${details.businessName}:`,
      `${what(details)}.`,
      // The ask goes only with a link to answer it (S78, AC-X-205).
      ...(link === null ? [] : confirmLines(details)),
      '',
      ...(link === null
        ? [
            'To reschedule or cancel, use the link in your booking confirmation email, or contact',
            `${details.businessName}.`,
          ]
        : [linkIntro(details), link]),
      ...policyLines(details),
    ].join('\n'),
  };
}

/**
 * The early ask to confirm (S78, AC-X-204): to a client whose visit is likely to be missed, 72
 * hours ahead, by email when no text may go. `link` confirms, reschedules or cancels.
 */
export function confirmAskEmail(details: BookingEmailDetails, link: string): EmailMessage {
  return {
    to: details.email,
    subject: `Please confirm your booking at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Please confirm your booking at ${details.businessName}:`,
      `${what(details)}.`,
      ...confirmLines(details),
      '',
      linkIntro(details),
      link,
      ...policyLines(details),
    ].join('\n'),
  };
}

/** The client's reschedule/cancel page; the secret goes in the fragment, never to a server. */
export function manageUrl(baseUrl: string, slug: string, token: string): string {
  return `${baseUrl}/book/${encodeURIComponent(slug)}/manage#${token}`;
}

/** The booking page's offer page; the claim secret goes in the fragment, never to a server. */
export function offerUrl(baseUrl: string, slug: string, token: string): string {
  return `${baseUrl}/book/${encodeURIComponent(slug)}/offer#${token}`;
}

/**
 * A freed time offered to a client on the waitlist (S37): transactional (they asked to hear),
 * with the time, until when it may be claimed, and the claim link. The first to claim books it.
 */
export function waitlistOfferEmail(
  details: BookingEmailDetails,
  claimUrl: string,
  expiresAt: string,
): EmailMessage {
  return {
    to: details.email,
    subject: `A time opened up at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `A time you were waiting for opened up at ${details.businessName}:`,
      `${what(details)}.`,
      '',
      'To take it, open this link (it is just for you):',
      claimUrl,
      '',
      `It was offered to a few people on the waitlist; whoever claims it first gets it. The offer ends ${formatWhen(expiresAt, details.timeZone)}.`,
    ].join('\n'),
  };
}

/**
 * A freed time offered to an overdue regular who isn't on the waitlist (S54, ADR-0056): their
 * usual service, the same single-use claim link, and the marketing footer a rebooking nudge
 * carries (the business's mailing address, a one-click unsubscribe link).
 */
export function regularOfferEmail(
  details: BookingEmailDetails,
  claimUrl: string,
  expiresAt: string,
  footer: { mailingAddress: string; unsubscribeUrl: string },
): EmailMessage {
  return {
    to: details.email,
    subject: `A time opened up at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `It has been a while, and a time just opened up at ${details.businessName}:`,
      `${what(details)}.`,
      '',
      'If you would like it, open this link (it is just for you):',
      claimUrl,
      '',
      `It was offered to a few clients; whoever claims it first gets it. The offer ends ${formatWhen(expiresAt, details.timeZone)}.`,
      '',
      '--',
      details.businessName,
      footer.mailingAddress,
      '',
      `You get this email because you are a client of ${details.businessName}.`,
      `Unsubscribe: ${footer.unsubscribeUrl}`,
    ].join('\n'),
  };
}

/** Another client claimed the time first, or it was booked meanwhile (S37). */
export function waitlistTakenEmail(details: BookingEmailDetails): EmailMessage {
  return {
    to: details.email,
    subject: `That time at ${details.businessName} has been taken`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `Sorry, the time we offered you at ${details.businessName} has been taken:`,
      `${what(details)}.`,
      '',
      'You are still on the waitlist, and we will let you know when another time opens up.',
    ].join('\n'),
  };
}
