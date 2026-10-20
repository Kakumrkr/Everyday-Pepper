import type { Transporter } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { SmtpMailer } from './mailer.js';

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

  it('builds an SMTP transport from the URL', () => {
    expect(
      () => new SmtpMailer({ smtpUrl: 'smtp://localhost:1025', from: 'Pepper <a@b.c>' }),
    ).not.toThrow();
  });
});
