import type { BookingEmailDetails } from '@pepper/appointments';
import type { EmailMessage } from '../mail/mailer.js';

// The booking page's emails (ADR-0022): plain text, in the business's time zone. They carry
// only what the client typed or booked; the code and the link are secrets for this client.

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

export function confirmationEmail(details: BookingEmailDetails, manageUrl: string): EmailMessage {
  return {
    to: details.email,
    subject: `You're booked at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `You're booked at ${details.businessName}:`,
      `${what(details)}.`,
      '',
      'To reschedule or cancel, use this link (it is just for you, so keep it private):',
      manageUrl,
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
      '',
      'To change it again or cancel:',
      manageUrl,
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
    ].join('\n'),
  };
}

/** The client's reschedule/cancel page; the secret goes in the fragment, never to a server. */
export function manageUrl(baseUrl: string, slug: string, token: string): string {
  return `${baseUrl}/book/${encodeURIComponent(slug)}/manage#${token}`;
}
