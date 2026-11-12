import {
  queueBookingEmail,
  queueBookingText,
  queueWaitlistTakenEmail,
  type BookingEmailOptions,
  type BookingNotice,
  type BookingNotify,
  type WaitlistTakenNotify,
} from '@pepper/appointments';
import type { TenantTx } from '@pepper/db';
import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';

export type BookingEmailsOptions = Omit<BookingEmailOptions, 'holdSeconds'>;

export const BOOKING_EMAILS_OPTIONS = Symbol('BOOKING_EMAILS_OPTIONS');

/**
 * The emails a booking's client gets when it is confirmed, moved or cancelled, from the
 * booking page or by the team (ADR-0024, ADR-0025), and the text with a confirmation (S62: the
 * opt-in text after a new consent, else a short confirmation): `notify` queues them in the
 * outbox inside the change's transaction, and the worker sends each exactly once.
 */
@Injectable()
export class BookingEmails {
  constructor(@Inject(BOOKING_EMAILS_OPTIONS) private readonly options: BookingEmailsOptions) {}

  /**
   * Queues the email about a change (clients without an email address get none), and the text
   * with a confirmation when the client can be texted.
   */
  readonly notify: BookingNotify = async (tx: TenantTx, notice: BookingNotice) => {
    await queueBookingEmail(tx, notice, this.options);
    await queueBookingText(tx, notice, this.options);
  };

  /** Queues the "that time has been taken" email to a waitlist client (S37). */
  readonly waitlistTaken: WaitlistTakenNotify = async (tx, notice) => {
    await queueWaitlistTakenEmail(tx, notice, this.options);
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
