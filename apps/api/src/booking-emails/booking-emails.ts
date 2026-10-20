import {
  cancelledEmail,
  confirmationEmail,
  manageUrl,
  rescheduledEmail,
  type BookingNotice,
  type BookingNotify,
} from '@pepper/appointments';
import { OutboxDedupeKeySchema } from '@pepper/contracts';
import { queueEmail, systemClock, type Clock, type EmailMessage } from '@pepper/core';
import type { TenantTx } from '@pepper/db';
import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';

export interface BookingEmailsOptions {
  /** The web app's origin, for the client's reschedule/cancel link. */
  baseUrl: string;
  /** Seals the emails queued in the outbox (ADR-0024). */
  outboxKey: Buffer;
  clock?: Clock;
}

export const BOOKING_EMAILS_OPTIONS = Symbol('BOOKING_EMAILS_OPTIONS');

/**
 * The emails a booking's client gets when it is confirmed, moved or cancelled, from the
 * booking page or by the team (ADR-0024, ADR-0025): `notify` queues one in the outbox inside
 * the change's transaction, and the worker sends it exactly once.
 */
@Injectable()
export class BookingEmails {
  constructor(@Inject(BOOKING_EMAILS_OPTIONS) private readonly options: BookingEmailsOptions) {}

  /** Queues the email about a change. Clients without an email address get none. */
  readonly notify: BookingNotify = async (tx: TenantTx, notice: BookingNotice) => {
    if (notice.email.email === '') return;
    const link = (token: string) => manageUrl(this.options.baseUrl, notice.email.slug, token);
    const message: EmailMessage =
      notice.kind === 'cancelled'
        ? cancelledEmail(notice.email)
        : notice.kind === 'confirmed'
          ? confirmationEmail(notice.email, link(notice.manageToken))
          : rescheduledEmail(notice.email, link(notice.manageToken));
    // One email per change: `at` is the booking's `updated_at`, one value per transaction.
    const { bookingId, at } = notice.change;
    await queueEmail(tx, message, {
      key: this.options.outboxKey,
      dedupeKey: OutboxDedupeKeySchema.parse(
        `booking.${notice.kind}:${bookingId}:${String(at.getTime())}`,
      ),
      now: (this.options.clock ?? systemClock).now(),
    });
  };
}

/** Provides `BookingEmails` to every module (the booking page's and the team's bookings). */
@Module({})
export class BookingEmailsModule {
  static forRoot(options: BookingEmailsOptions): DynamicModule {
    return {
      module: BookingEmailsModule,
      global: true,
      providers: [{ provide: BOOKING_EMAILS_OPTIONS, useValue: options }, BookingEmails],
      exports: [BookingEmails],
    };
  }
}
