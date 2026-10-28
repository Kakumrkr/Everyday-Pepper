import type { EmailMessage } from '@pepper/core';
import { describe, expect, it, vi } from 'vitest';
import {
  AccountMailer,
  accountExistsEmail,
  changeOf,
  confirmNewEmailEmail,
  emailChangeNoticeEmail,
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

  it('tells the old address about a change, and the owner of a taken address where to sign in', () => {
    const notice = emailChangeNoticeEmail(
      { ...ana, email: 'new@example.test' },
      'ana@example.test',
      'new@example.test',
    );
    expect(notice.to).toBe('ana@example.test');
    expect(notice.text).toContain('new@example.test');
    expect(notice.text).toContain('Forgot your password?');
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

describe('AccountMailer', () => {
  it('never fails the request, and logs no address when a send fails', async () => {
    const log = vi.fn();
    const failing = {
      send: vi.fn((message: EmailMessage) =>
        Promise.reject(new Error(`refused for ${message.to}`)),
      ),
    };
    await new AccountMailer(failing, log).send('password reset', resetPasswordEmail(ana, 'u'));
    expect(log).toHaveBeenCalledWith('error', 'Could not send the password reset email: Error');
    expect(JSON.stringify(log.mock.calls)).not.toContain('ana@example.test');
    await new AccountMailer(null, log).send('email check', verifyEmailEmail(ana, 'u'));
    expect(log).toHaveBeenLastCalledWith(
      'warn',
      'No mailer configured: the email check email was not sent',
    );
  });
});
