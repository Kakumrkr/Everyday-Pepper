import type { EmailMessage, Mailer } from '@pepper/core';
import { z } from 'zod';

// The account emails (S44, ADR-0045): a password reset, a new account's email check, a change
// of email (confirmed by the current address, then the new one), and "you already have an account" for a
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

/** To the new address, once the current one confirmed: nothing changes until it is opened. */
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

/**
 * To the current address first (S44 review): a change starts only once it is confirmed here, so
 * a stolen session alone can't move the account to another address.
 */
export function confirmChangeEmail(user: Person, newEmail: string, url: string): EmailMessage {
  return {
    to: user.email,
    subject: 'Confirm the change of your Pepper email',
    text: [
      hello(user.name),
      '',
      `You asked to sign in to Pepper with ${newEmail} from now on. To confirm, open this link:`,
      '',
      `    ${url}`,
      '',
      `Then we send one more link to ${newEmail}. It works for ${String(VERIFY_LINK_HOURS)} hours.`,
      'If you did not ask for this, do not open the link: nothing changes. Someone may know your',
      'password, so choose a new one: "Forgot your password?" on the sign-in page.',
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

const StepTokenSchema = z.object({ requestType: z.string() });

/**
 * Whether an email check link's token is a change of address's last step (the new address
 * confirming), read from its payload as `changeOf` does. Only called once Better Auth has
 * verified that token (L15: the other sessions then end).
 */
export function isFinishedChangeOf(token: string): boolean {
  const payload = token.split('.')[1];
  if (payload === undefined) return false;
  try {
    const parsed = StepTokenSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    );
    return parsed.success && parsed.data.requestType === 'change-email-verification';
  } catch {
    return false;
  }
}

/**
 * Sends account emails in the background, never failing or slowing the request: a refusal, or
 * the time an SMTP round trip takes, would tell an address that has an account from one that
 * hasn't. A failure is logged (without the address) and the person can ask again ("Send the
 * link again", "Forgot your password?").
 */
export class AccountMailer {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly mailer: Mailer | null,
    private readonly log: (level: 'warn' | 'error', message: string) => void,
  ) {}

  /** Starts sending and returns at once. */
  send(kind: string, ...messages: EmailMessage[]): Promise<void> {
    const sending = this.deliver(kind, messages).finally(() => {
      this.pending.delete(sending);
    });
    this.pending.add(sending);
    return Promise.resolve();
  }

  /** Waits for the emails being sent (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private async deliver(kind: string, messages: EmailMessage[]): Promise<void> {
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

/** `url` (an emailed Better Auth link) landing on `path` once opened. */
export function landingOn(url: string, path: string): string {
  const link = new URL(url);
  link.searchParams.set('callbackURL', path);
  return link.toString();
}
