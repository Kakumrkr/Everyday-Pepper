import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { EmailMessage, Mailer } from '@pepper/core';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailConfig } from './config.js';

/** The process's `Mailer` (`@pepper/core`), or `null` when no SMTP_URL is configured. */
export const MAILER = Symbol('MAILER');

/**
 * A `Mailer` over SMTP (nodemailer): Mailpit in development and CI. Timeouts stay well below
 * the outbox lease (ADR-0024), so a hung server fails the attempt instead of outliving it.
 */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly domain: string;

  constructor(
    private readonly config: MailConfig,
    transport?: Transporter,
  ) {
    this.transport =
      transport ??
      createTransport({
        url: config.smtpUrl,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
      });
    this.domain = /@([A-Za-z0-9.-]+)/.exec(config.from)?.[1] ?? 'pepper.localhost';
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      // One line: a name with a line break must not start another header.
      subject: message.subject.replace(/\s+/g, ' ').trim(),
      text: message.text,
      ...(message.id !== undefined && { messageId: `<${message.id}@${this.domain}>` }),
      ...(message.replyTo !== undefined && { replyTo: message.replyTo }),
      // RFC 8058 one-click unsubscribe (S36): mail providers POST to the address themselves.
      ...(message.unsubscribeUrl !== undefined && {
        headers: {
          'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
  }

  close(): void {
    this.transport.close();
  }
}

@Injectable()
class MailLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MAILER) private readonly mailer: Mailer | null) {}

  onApplicationShutdown(): void {
    if (this.mailer instanceof SmtpMailer) this.mailer.close();
  }
}

/** Provides `MAILER` from the process's mail configuration. */
@Module({})
export class MailModule {
  static forRoot(config: MailConfig | null): DynamicModule {
    return {
      module: MailModule,
      global: true,
      providers: [
        { provide: MAILER, useFactory: () => (config === null ? null : new SmtpMailer(config)) },
        MailLifecycle,
      ],
      exports: [MAILER],
    };
  }
}
