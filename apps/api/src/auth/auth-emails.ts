import type { EmailMessage, Mailer } from '@pepper/core';
import { z } from 'zod';

// The account emails (S44, ADR-0045): a password reset, a new account's email check, a new
// address's check and a notice to the old one, and "you already have an account" for a
// sign-up with a taken address. Sent at once through the mailer, not the outbox: an account
// has no business yet (the outbox is per business), and the person is waiting for the link.

/** How long a password reset link works (Better Auth keeps it single-use). */
export const RESET_LINK_MINUTES = 60;
/** How long an email check link works (a new account's, or a new address's). */
export const VERIFY_LINK_HOURS = 24;

interface Person {
  name: string;
  email: string;
}

/** "Hi Ana," for a name, "Hi," for none (a name is never required to be set). */
function hello(name: string): string {
  const first = name.trim().split(/\s+/)[0] ?? '';
  return first === '' ? 'Hi,' : `Hi ${first},`;
}

export function resetPasswordEmail(user: Person, url: string): EmailMessage {
  return {
    to: user.email,
    subject: 'Reset your Pepper password',
    text: [
      hello(user.name),
      '',
      'To choose a new password for Pepper, open this link:',
      '',
      `    ${url}`,
      '',
      `It works once, for ${String(RESET_LINK_MINUTES)} minutes. A new password signs you out on every other device.`,
      'If you did not ask for this, you can ignore this email: your password stays as it is.',
    ].join('\n'),
  };
}

export function verifyEmailEmail(user: Person, url: string): EmailMessage {
  return {
    to: user.email,
    subject: 'Confirm your email for Pepper',
    text: [
      hello(user.name),
      '',
      'Open this link to confirm your email and finish setting up Pepper:',
      '',
      `    ${url}`,
      '',
      `It works for ${String(VERIFY_LINK_HOURS)} hours. If it runs out, sign in and Pepper sends a new one.`,
      'If you did not create a Pepper account, you can ignore this email.',
    ].join('\n'),
  };
}

/** To the new address: nothing changes until it is opened. */
export function confirmNewEmailEmail(user: Person, newEmail: string, url: string): EmailMessage {
  return {
    to: newEmail,
    subject: 'Confirm your new email for Pepper',
    text: [
      hello(user.name),
      '',
      'Open this link to sign in to Pepper with this address from now on:',
      '',
      `    ${url}`,
      '',
      `Until you do, you keep signing in with your old address. It works for ${String(VERIFY_LINK_HOURS)} hours.`,
      'If you did not ask for this, you can ignore this email.',
    ].join('\n'),
  };
}

/** To the old address at the same time, so a change nobody asked for doesn't go unseen. */
export function emailChangeNoticeEmail(
  user: Person,
  oldEmail: string,
  newEmail: string,
): EmailMessage {
  return {
    to: oldEmail,
    subject: 'Your Pepper email is about to change',
    text: [
      hello(user.name),
      '',
      `Someone signed in to your Pepper account asked to change its email to ${newEmail}.`,
      'Nothing changes until that address confirms it.',
      '',
      'If this was you, there is nothing to do. If it was not, change your password now:',
      'sign in, or choose "Forgot your password?" on the sign-in page.',
    ].join('\n'),
  };
}

/** A sign-up with a taken address: the page says the same as for a new one (no oracle). */
export function accountExistsEmail(user: Person, signInUrl: string): EmailMessage {
  return {
    to: user.email,
    subject: 'You already have a Pepper account',
    text: [
      hello(user.name),
      '',
      'Someone tried to create a Pepper account with this email, and you already have one.',
      '',
      `Sign in here: ${signInUrl}`,
      'Forgot your password? Choose "Forgot your password?" on that page.',
      '',
      'If this was not you, you can ignore this email: nothing changed.',
    ].join('\n'),
  };
}

const ChangeTokenSchema = z.object({ email: z.string(), updateTo: z.string() });

/**
 * The change of address an email check is for (`from` the current address, `to` the new one),
 * or `null` for a new account's own address. Better Auth signs its email check links as JWTs
 * carrying `updateTo` for a change; this only reads the payload to pick the words and the old
 * address to tell (Better Auth verifies the token when the link is opened).
 */
export function changeOf(token: string): { from: string; to: string } | null {
  const payload = token.split('.')[1];
  if (payload === undefined) return null;
  try {
    const parsed = ChangeTokenSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success ? { from: parsed.data.email, to: parsed.data.updateTo } : null;
  } catch {
    return null;
  }
}

/**
 * Sends account emails, never failing the request: an error would tell an address that has an
 * account from one that hasn't, so it is logged (without the address) and the person can ask
 * again ("Send again", "Forgot your password?").
 */
export class AccountMailer {
  constructor(
    private readonly mailer: Mailer | null,
    private readonly log: (level: 'warn' | 'error', message: string) => void,
  ) {}

  async send(kind: string, ...messages: EmailMessage[]): Promise<void> {
    if (this.mailer === null) {
      this.log('warn', `No mailer configured: the ${kind} email was not sent`);
      return;
    }
    for (const message of messages) {
      try {
        await this.mailer.send(message);
      } catch (error) {
        this.log(
          'error',
          `Could not send the ${kind} email: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
  }
}
