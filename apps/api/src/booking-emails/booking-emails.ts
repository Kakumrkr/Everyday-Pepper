import {
  queueBookingEmail,
  type BookingEmailOptions,
  type BookingNotice,
  type BookingNotify,
} from '@pepper/appointments';
import type { TenantTx } from '@pepper/db';
import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';

export type BookingEmailsOptions = Omit<BookingEmailOptions, 'holdSeconds'>;

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
    await queueBookingEmail(tx, notice, this.options);
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
