import {
  cancelManagedBooking,
  confirmBookingRequest,
  findPublicAvailability,
  getManagedBooking,
  getPublicBusiness,
  rescheduleManagedBooking,
  requestBooking,
  type BookingNotice,
  type BookingNotify,
} from '@pepper/appointments';
import {
  OutboxDedupeKeySchema,
  VERIFICATION_CODE_TTL_MINUTES,
  type AvailabilityQueryInput,
  type AvailableSlot,
  type BookingConfirmInput,
  type BookingConfirmResponse,
  type BookingRequest,
  type BookingRequestId,
  type BookingRequestResponse,
  type ManageToken,
  type PublicBooking,
  type PublicBusiness,
  type TenantSlug,
} from '@pepper/contracts';
import { queueEmail, systemClock, type Clock, type EmailMessage, type Mailer } from '@pepper/core';
import type { Database, TenantTx } from '@pepper/db';
import { DATABASE, MAILER } from '@pepper/runtime';
import { templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';
import {
  cancelledEmail,
  codeEmail,
  confirmationEmail,
  manageUrl,
  rescheduledEmail,
} from './emails.js';

export interface PublicBookingOptions {
  /** The web app's origin, for links in emails. */
  baseUrl: string;
  /** HMAC key of the stored code hashes. */
  codeKey: Buffer;
  /** Seals the emails queued in the outbox (ADR-0024). */
  outboxKey: Buffer;
  clock?: Clock;
}

export const PUBLIC_BOOKING_OPTIONS = Symbol('PUBLIC_BOOKING_OPTIONS');

/**
 * The public booking page's services for a request (ADR-0022): binds the database, the code
 * key and the industry templates' rule defaults. The code email is sent at once, because the
 * client is waiting for it: failing to send it is an error (503). The emails about a booking
 * (confirmed, moved, cancelled) are queued in the outbox inside the change's transaction, and
 * the worker sends each exactly once, with retries (ADR-0024).
 */
@Injectable()
export class PublicBookingService {
  private readonly db: Database;
  private readonly logger = new Logger(PublicBookingService.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(PUBLIC_BOOKING_OPTIONS) private readonly options: PublicBookingOptions,
  ) {
    this.db = database.db;
  }

  business(slug: TenantSlug): Promise<PublicBusiness> {
    return getPublicBusiness(this.db, slug);
  }

  availability(
    slug: TenantSlug,
    query: AvailabilityQueryInput,
    limit: number,
  ): Promise<AvailableSlot[]> {
    return findPublicAvailability(this.db, slug, query, { templateRuleDefaults, limit });
  }

  async request(slug: TenantSlug, input: BookingRequest): Promise<BookingRequestResponse> {
    const mailer = this.requireMailer();
    const asked = await requestBooking(this.db, slug, input, {
      codeKey: this.options.codeKey,
      templateRuleDefaults,
    });
    try {
      await mailer.send(codeEmail(asked.email, asked.code, VERIFICATION_CODE_TTL_MINUTES));
    } catch (error) {
      this.logger.error(`Could not send a booking code: ${messageOf(error)}`);
      throw new ServiceUnavailableException(apiError('email_unavailable'));
    }
    return { requestId: asked.requestId, expiresAt: asked.expiresAt };
  }

  async confirm(
    slug: TenantSlug,
    requestId: BookingRequestId,
    input: BookingConfirmInput,
  ): Promise<BookingConfirmResponse> {
    const confirmed = await confirmBookingRequest(this.db, slug, requestId, input, {
      codeKey: this.options.codeKey,
      templateRuleDefaults,
      notify: this.notifier(slug),
    });
    return { booking: confirmed.booking, manageToken: confirmed.manageToken };
  }

  managed(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    return getManagedBooking(this.db, slug, token);
  }

  async reschedule(slug: TenantSlug, token: ManageToken, startsAt: string): Promise<PublicBooking> {
    const moved = await rescheduleManagedBooking(this.db, slug, token, startsAt, {
      templateRuleDefaults,
      notify: this.notifier(slug),
    });
    return moved.booking;
  }

  async cancel(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    const cancelled = await cancelManagedBooking(this.db, slug, token, {
      notify: this.notifier(slug),
    });
    return cancelled.booking;
  }

  /** The mailer; 503 `email_unavailable` when none is configured. */
  private requireMailer(): Mailer {
    if (this.mailer === null) {
      throw new ServiceUnavailableException(apiError('email_unavailable'));
    }
    return this.mailer;
  }

  /**
   * Queues the email about a booking change in the change's transaction. Clients without an
   * email address get none.
   */
  private notifier(slug: TenantSlug): BookingNotify {
    return async (tx: TenantTx, notice: BookingNotice) => {
      if (notice.email.email === '') return;
      const link = (token: ManageToken) => manageUrl(this.options.baseUrl, slug, token);
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
