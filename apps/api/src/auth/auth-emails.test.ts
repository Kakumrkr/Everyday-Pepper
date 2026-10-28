import type { EmailMessage } from '@pepper/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountMailer,
  accountExistsEmail,
  changeOf,
  confirmChangeEmail,
  confirmNewEmailEmail,
  landingOn,
  resetPasswordEmail,
  verifyEmailEmail,
} from './auth-emails.js';

const ana = { name: 'Ana Reyes', email: 'ana@example.test' };
const token = (payload: object) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

describe('the account emails (S44)', () => {
  it('greet by first name, carry the link, and say what happens if it was not you', () => {
    const emails = [
      resetPasswordEmail(ana, 'https://app.example/reset'),
      verifyEmailEmail(ana, 'https://app.example/verify'),
      confirmNewEmailEmail(ana, 'new@example.test', 'https://app.example/change'),
    ];
    for (const email of emails) {
      expect(email.text.startsWith('Hi Ana,')).toBe(true);
      expect(email.text).toMatch(/https:\/\/app\.example\/\w+/);
      expect(email.text).toMatch(/If you did not/);
      // DESIGN §6: no exclamation marks.
      expect(`${email.subject} ${email.text}`).not.toContain('!');
    }
    expect(emails.map((e) => e.to)).toEqual([
      'ana@example.test',
      'ana@example.test',
      'new@example.test',
    ]);
    expect(resetPasswordEmail({ name: ' ', email: 'x@example.test' }, 'u').text).toMatch(/^Hi,/);
  });

  it('asks the current address to confirm a change, and tells a taken address where to sign in', () => {
    const confirm = confirmChangeEmail(ana, 'new@example.test', 'https://app.example/c');
    expect(confirm.to).toBe('ana@example.test');
    expect(confirm.text).toContain('new@example.test');
    expect(confirm.text).toContain('https://app.example/c');
    expect(confirm.text).toContain('Forgot your password?');
    const exists = accountExistsEmail(ana, 'https://app.example/sign-in');
    expect(exists.text).toContain('https://app.example/sign-in');
  });
});

describe('changeOf', () => {
  it('reads a change of address from the link token, and nothing from any other', () => {
    expect(changeOf(token({ email: 'a@x.test', updateTo: 'b@x.test' }))).toEqual({
      from: 'a@x.test',
      to: 'b@x.test',
    });
    expect(changeOf(token({ email: 'a@x.test' }))).toBeNull();
    expect(changeOf('not a token')).toBeNull();
    expect(changeOf('h.%%%.s')).toBeNull();
  });
});

describe('landingOn', () => {
  it('sets where an emailed Better Auth link lands, keeping its token', () => {
    const link = landingOn(
      'https://app.example/api/auth/verify-email?token=abc&callbackURL=%2Faccount',
      '/email-confirmed?changed=1',
    );
    const url = new URL(link);
    expect(url.searchParams.get('token')).toBe('abc');
    expect(url.searchParams.get('callbackURL')).toBe('/email-confirmed?changed=1');
  });
});

describe('AccountMailer', () => {
  it('returns before the mail server answers (no timing oracle), and never fails the request', async () => {
    let answer: () => void = () => undefined;
    const slow = {
      send: vi.fn(() => new Promise<void>((resolve) => (answer = resolve))),
    };
    const mailer = new AccountMailer(slow, vi.fn());
    await mailer.send('password reset', resetPasswordEmail(ana, 'u'));
    expect(slow.send).toHaveBeenCalledTimes(1);
    answer();
    await mailer.settled();
  });

  it('logs no address when a send fails', async () => {
    const log = vi.fn();
    const failing = {
      send: vi.fn((message: EmailMessage) =>
        Promise.reject(new Error(`refused for ${message.to}`)),
      ),
    };
    const mailer = new AccountMailer(failing, log);
    await mailer.send('password reset', resetPasswordEmail(ana, 'u'));
    await mailer.settled();
    expect(log).toHaveBeenCalledWith('error', 'Could not send the password reset email: Error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('ana@example.test');
    const none = new AccountMailer(null, log);
    await none.send('email check', verifyEmailEmail(ana, 'u'));
    await none.settled();
    expect(log).toHaveBeenLastCalledWith(
      'warn',
      'No mailer configured: the email check email was not sent',
    );
  });
});
