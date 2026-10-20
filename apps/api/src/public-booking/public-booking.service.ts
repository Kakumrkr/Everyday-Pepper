import {
  cancelManagedBooking,
  confirmBookingRequest,
  findPublicAvailability,
  getManagedBooking,
  getPublicBusiness,
  rescheduleManagedBooking,
  requestBooking,
  codeEmail,
} from '@pepper/appointments';
import {
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
import type { Mailer } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE, MAILER } from '@pepper/runtime';
import { templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';
import { BookingEmails } from '../booking-emails/booking-emails.js';

export interface PublicBookingOptions {
  /** HMAC key of the stored code hashes. */
  codeKey: Buffer;
}

export const PUBLIC_BOOKING_OPTIONS = Symbol('PUBLIC_BOOKING_OPTIONS');

/**
 * The public booking page's services for a request (ADR-0022): binds the database, the code
 * key and the industry templates' rule defaults. The code email is sent at once, because the
 * client is waiting for it: failing to send it is an error (503). The emails about a booking
 * (confirmed, moved, cancelled) are queued in the outbox inside the change's transaction by
 * `BookingEmails`, and the worker sends each exactly once, with retries (ADR-0024).
 */
@Injectable()
export class PublicBookingService {
  private readonly db: Database;
  private readonly logger = new Logger(PublicBookingService.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(PUBLIC_BOOKING_OPTIONS) private readonly options: PublicBookingOptions,
    private readonly emails: BookingEmails,
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
      notify: this.emails.notify,
    });
    return { booking: confirmed.booking, manageToken: confirmed.manageToken };
  }

  managed(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    return getManagedBooking(this.db, slug, token);
  }

  async reschedule(slug: TenantSlug, token: ManageToken, startsAt: string): Promise<PublicBooking> {
    const moved = await rescheduleManagedBooking(this.db, slug, token, startsAt, {
      templateRuleDefaults,
      notify: this.emails.notify,
    });
    return moved.booking;
  }

  async cancel(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    const cancelled = await cancelManagedBooking(this.db, slug, token, {
      notify: this.emails.notify,
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
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
