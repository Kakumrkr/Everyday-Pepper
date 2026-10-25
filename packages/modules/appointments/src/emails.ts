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

/**
 * The reminder a day before (AC-W6-1). It carries no link: only the link's hash is stored, so
 * the client uses the one from their confirmation, or contacts the business.
 */
export function reminderEmail(details: BookingEmailDetails): EmailMessage {
  return {
    to: details.email,
    subject: `Reminder: your booking at ${details.businessName}`,
    text: [
      `Hi ${details.clientName},`,
      '',
      `This is a reminder of your booking at ${details.businessName}:`,
      `${what(details)}.`,
      '',
      'To reschedule or cancel, use the link in your booking confirmation email, or contact',
      `${details.businessName}.`,
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
