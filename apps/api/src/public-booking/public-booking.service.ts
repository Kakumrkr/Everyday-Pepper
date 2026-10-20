import {
  cancelManagedBooking,
  confirmBookingRequest,
  findPublicAvailability,
  getManagedBooking,
  getPublicBusiness,
  rescheduleManagedBooking,
  requestBooking,
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
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';
import { MAILER, type EmailMessage, type Mailer } from '../mail/mailer.js';
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
}

export const PUBLIC_BOOKING_OPTIONS = Symbol('PUBLIC_BOOKING_OPTIONS');

/**
 * The public booking page's services for a request (ADR-0022): binds the database, the code
 * key and the industry templates' rule defaults, and sends the emails. The code email must
 * reach the client, so failing to send it is an error (503); the other emails are best
 * effort, as the page shows the same details and link.
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
    });
    await this.sendQuietly(
      confirmationEmail(confirmed.email, this.manageUrl(slug, confirmed.manageToken)),
    );
    return { booking: confirmed.booking, manageToken: confirmed.manageToken };
  }

  managed(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    return getManagedBooking(this.db, slug, token);
  }

  async reschedule(slug: TenantSlug, token: ManageToken, startsAt: string): Promise<PublicBooking> {
    const moved = await rescheduleManagedBooking(this.db, slug, token, startsAt, {
      templateRuleDefaults,
    });
    await this.sendQuietly(rescheduledEmail(moved.email, this.manageUrl(slug, token)));
    return moved.booking;
  }

  async cancel(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    const cancelled = await cancelManagedBooking(this.db, slug, token);
    await this.sendQuietly(cancelledEmail(cancelled.email));
    return cancelled.booking;
  }

  /** The mailer; 503 `email_unavailable` when none is configured. */
  private requireMailer(): Mailer {
    if (this.mailer === null) {
      throw new ServiceUnavailableException(apiError('email_unavailable'));
    }
    return this.mailer;
  }

  private manageUrl(slug: TenantSlug, token: ManageToken): string {
    return manageUrl(this.options.baseUrl, slug, token);
  }

  /** Sends an email whose content the page also shows; a failure is logged, not raised. */
  private async sendQuietly(message: EmailMessage): Promise<void> {
    if (this.mailer === null || message.to === '') return;
    try {
      await this.mailer.send(message);
    } catch (error) {
      // Never the address or the content: they are personal data and carry the link.
      this.logger.warn(`Could not send a booking email: ${messageOf(error)}`);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}
