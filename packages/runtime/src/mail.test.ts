import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { loadMailConfig, loadOutboxSecret } from './config.js';
import { SmtpMailer } from './mail.js';

describe('SmtpMailer', () => {
  it('sends plain text from the configured sender, the subject on one line', async () => {
    const sendMail = vi.fn(() => Promise.resolve({}));
    const close = vi.fn();
    const mailer = new SmtpMailer(
      { smtpUrl: 'smtp://localhost:1025', from: 'Pepper <bookings@pepper.localhost>' },
      { sendMail, close } as unknown as Transporter,
    );
    await mailer.send({
      to: 'ana@example.test',
      subject: "You're booked at Juniper\r\nBcc: someone@example.test",
      text: 'Hi',
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'Pepper <bookings@pepper.localhost>',
      to: 'ana@example.test',
      subject: "You're booked at Juniper Bcc: someone@example.test",
      text: 'Hi',
    });
    mailer.close();
    expect(close).toHaveBeenCalled();
  });

  it("gives an outbox email a stable Message-ID at the sender's domain", async () => {
    const sendMail = vi.fn(() => Promise.resolve({}));
    const transport = { sendMail, close: vi.fn() } as unknown as Transporter;
    const send = (from: string) =>
      new SmtpMailer({ smtpUrl: 'smtp://localhost:1025', from }, transport).send({
        to: 'ana@example.test',
        subject: 'S',
        text: 'T',
        id: '0199f4b2-7c1e-7a00-8000-000000000001',
      });
    await send('Juniper <hello@juniper.example>');
    await send('no address here');
    expect(sendMail.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      expect.objectContaining({
        messageId: '<0199f4b2-7c1e-7a00-8000-000000000001@juniper.example>',
      }),
      expect.objectContaining({
        messageId: '<0199f4b2-7c1e-7a00-8000-000000000001@pepper.localhost>',
      }),
    ]);
  });

  it('builds an SMTP transport from the URL', () => {
    expect(
      () => new SmtpMailer({ smtpUrl: 'smtp://localhost:1025', from: 'Pepper <a@b.c>' }),
    ).not.toThrow();
  });
});

describe('loadMailConfig', () => {
  it('has no email sender unless SMTP_URL is set, and a default sender address', () => {
    expect(loadMailConfig('worker', {})).toBeNull();
    expect(loadMailConfig('worker', { SMTP_URL: '' })).toBeNull();
    expect(loadMailConfig('worker', { SMTP_URL: 'smtp://localhost:1025' })).toEqual({
      smtpUrl: 'smtp://localhost:1025',
      from: 'Pepper <bookings@pepper.localhost>',
    });
    expect(
      loadMailConfig('api', { SMTP_URL: 'smtps://u:p@mail.example', MAIL_FROM: 'Juniper <a@b.c>' }),
    ).toEqual({ smtpUrl: 'smtps://u:p@mail.example', from: 'Juniper <a@b.c>' });
  });

  it('rejects an SMTP_URL that is not smtp, without echoing it', () => {
    expect(() => loadMailConfig('worker', { SMTP_URL: 'http://u:secret@mail.example' })).toThrow(
      /^Invalid worker environment: SMTP_URL$/,
    );
  });
});

describe('loadOutboxSecret', () => {
  it('needs a secret of at least 32 characters, without echoing it', () => {
    const secret = 'an-outbox-secret-of-32-characters!';
    expect(loadOutboxSecret('api', { OUTBOX_SECRET: secret })).toBe(secret);
    for (const env of [{}, { OUTBOX_SECRET: '' }, { OUTBOX_SECRET: 'short-secret' }]) {
      expect(() => loadOutboxSecret('worker', env)).toThrow(
        /^Invalid worker environment: OUTBOX_SECRET$/,
      );
    }
  });
});
