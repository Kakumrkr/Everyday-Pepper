import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { MailConfig } from '../config.js';

/** One plain-text email. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Sends email (ADR-0022). For now the api sends directly over SMTP while the client waits;
 * Phase 5 moves sending behind the transactional outbox, with retries, without changing
 * callers' messages.
 */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** The process's `Mailer`, or `null` when no SMTP_URL is configured. */
export const MAILER = Symbol('MAILER');

/** A `Mailer` over SMTP (nodemailer): Mailpit in development and CI. */
export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(
    private readonly config: MailConfig,
    transport?: Transporter,
  ) {
    this.transport = transport ?? createTransport(config.smtpUrl);
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({
      from: this.config.from,
      to: message.to,
      // One line: a name with a line break must not start another header.
      subject: message.subject.replace(/\s+/g, ' ').trim(),
      text: message.text,
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

/** Provides `MAILER` from the api's mail configuration. */
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
