import {
  cancelManagedBooking,
  claimWaitlistOffer,
  confirmBookingRequest,
  findPublicAvailability,
  getManagedBooking,
  getPublicBusiness,
  getWaitlistOffer,
  rescheduleManagedBooking,
  requestBooking,
  codeEmail,
  forgetDevice,
  recordBookingStep,
  confirmWaitlistJoin,
  requestWaitlistJoin,
  waitlistCodeEmail,
  type BookingNotify,
} from '@pepper/appointments';
import {
  VERIFICATION_CODE_TTL_MINUTES,
  type AvailabilityQueryInput,
  type AvailableSlot,
  type BookingConfirmInput,
  type BookingConfirmResponse,
  type BookingFunnelEventInput,
  type DeviceToken,
  type BookingRequest,
  type BookingRequestId,
  type BookingRequestResponse,
  type ManageToken,
  type OfferToken,
  type PublicBooking,
  type PublicOffer,
  type PublicBusiness,
  type TenantSlug,
  type WaitlistConfirmInput,
  type WaitlistConfirmResponse,
  type WaitlistRequest,
} from '@pepper/contracts';
import type { Mailer } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE, MAILER } from '@pepper/runtime';
import { templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';
import { BookingEmails } from '../booking-emails/booking-emails.js';
import { TeamPushes } from '../push/team-pushes.js';

export interface PublicBookingOptions {
  /** HMAC key of the stored code hashes. */
  codeKey: Buffer;
  /** Whether the remembered-device cookie is `Secure` (the app is served over https). */
  secureCookies?: boolean;
}

export const PUBLIC_BOOKING_OPTIONS = Symbol('PUBLIC_BOOKING_OPTIONS');

/**
 * The public booking page's services for a request (ADR-0022): binds the database, the code
 * key and the industry templates' rule defaults. The code email is sent at once, because the
 * client is waiting for it: failing to send it is an error (503). The emails about a booking
 * (confirmed, moved, cancelled) are queued in the outbox inside the change's transaction by
 * `BookingEmails`, and the worker sends each exactly once, with retries (ADR-0024); the team
 * hears about them by push (`TeamPushes`, ADR-0026).
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
    private readonly pushes: TeamPushes,
  ) {
    this.db = database.db;
  }

  /** The client's email and the team's push about a change, both in its transaction. */
  private readonly notify: BookingNotify = async (tx, notice) => {
    await this.emails.notify(tx, notice);
    await this.pushes.bookingPage(tx, notice);
  };

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

  /** Whether the device cookie is sent only over https. */
  get secureCookies(): boolean {
    return this.options.secureCookies === true;
  }

  /**
   * Asks to book. From a device the business remembers for that email (S47, AC-W8-8), the
   * request is confirmed at once with its own code, so no code email is sent and the answer
   * carries the booking (`confirmed`).
   */
  async request(
    slug: TenantSlug,
    input: BookingRequest,
    deviceToken?: DeviceToken,
  ): Promise<{ response: BookingRequestResponse; refreshDevice?: DeviceToken }> {
    // A remembered device sends no code email, so only a browser without one needs the mailer
    // before anything is stored.
    if (deviceToken === undefined) this.requireMailer();
    const asked = await requestBooking(this.db, slug, input, {
      codeKey: this.options.codeKey,
      templateRuleDefaults,
      deviceToken,
    });
    if (asked.remembered && deviceToken !== undefined) {
      const { response } = await this.confirm(slug, asked.requestId, { code: asked.code });
      // Its 90 days start again, so the cookie's do too.
      return {
        response: { requestId: asked.requestId, expiresAt: asked.expiresAt, confirmed: response },
        refreshDevice: deviceToken,
      };
    }
    const mailer = this.requireMailer();
    try {
      await mailer.send(codeEmail(asked.email, asked.code, VERIFICATION_CODE_TTL_MINUTES));
    } catch (error) {
      this.logger.error(`Could not send a booking code: ${messageOf(error)}`);
      throw new ServiceUnavailableException(apiError('email_unavailable'));
    }
    return { response: { requestId: asked.requestId, expiresAt: asked.expiresAt } };
  }

  /** "Join the waitlist" (S38a): the code is emailed at once, like a booking's. */
  async waitlistRequest(slug: TenantSlug, input: WaitlistRequest): Promise<BookingRequestResponse> {
    const mailer = this.requireMailer();
    const asked = await requestWaitlistJoin(this.db, slug, input, {
      codeKey: this.options.codeKey,
    });
    try {
      await mailer.send(waitlistCodeEmail(asked.email, asked.code, VERIFICATION_CODE_TTL_MINUTES));
    } catch (error) {
      this.logger.error(`Could not send a waitlist code: ${messageOf(error)}`);
      throw new ServiceUnavailableException(apiError('email_unavailable'));
    }
    return { requestId: asked.requestId, expiresAt: asked.expiresAt };
  }

  waitlistConfirm(
    slug: TenantSlug,
    requestId: BookingRequestId,
    input: WaitlistConfirmInput,
  ): Promise<WaitlistConfirmResponse> {
    return confirmWaitlistJoin(this.db, slug, requestId, input, { codeKey: this.options.codeKey });
  }

  /** Confirms with the code; `device`: the new secret when the client asked to be remembered. */
  async confirm(
    slug: TenantSlug,
    requestId: BookingRequestId,
    input: BookingConfirmInput,
    deviceToken?: DeviceToken,
  ): Promise<{ response: BookingConfirmResponse; device?: DeviceToken }> {
    const confirmed = await confirmBookingRequest(this.db, slug, requestId, input, {
      deviceToken,
      codeKey: this.options.codeKey,
      templateRuleDefaults,
      notify: this.notify,
    });
    return {
      response: { booking: confirmed.booking, manageToken: confirmed.manageToken },
      ...(confirmed.device === undefined ? {} : { device: confirmed.device.token }),
    };
  }

  /** "Forget this device" (S47): the business stops remembering the browser's token. */
  forget(slug: TenantSlug, token: DeviceToken | undefined): Promise<boolean> {
    return forgetDevice(this.db, slug, token);
  }

  /**
   * A visit entered a step (S47, AC-W8-9). Never fails the caller: the page doesn't wait on
   * it, and a lost count is better than a lost booking.
   */
  async funnelStep(slug: TenantSlug, event: BookingFunnelEventInput): Promise<void> {
    try {
      await recordBookingStep(this.db, slug, event);
    } catch (error) {
      this.logger.warn(`Could not record a booking step: ${messageOf(error)}`);
    }
  }

  managed(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    return getManagedBooking(this.db, slug, token);
  }

  async reschedule(slug: TenantSlug, token: ManageToken, startsAt: string): Promise<PublicBooking> {
    const moved = await rescheduleManagedBooking(this.db, slug, token, startsAt, {
      templateRuleDefaults,
      notify: this.notify,
    });
    return moved.booking;
  }

  async cancel(slug: TenantSlug, token: ManageToken): Promise<PublicBooking> {
    const cancelled = await cancelManagedBooking(this.db, slug, token, {
      notify: this.notify,
    });
    return cancelled.booking;
  }

  /** The waitlist offer behind a claim link (S37); reading it changes nothing. */
  offer(slug: TenantSlug, token: OfferToken): Promise<PublicOffer> {
    return getWaitlistOffer(this.db, slug, token);
  }

  /**
   * Claims the offer: the first claim books the time (with its confirmation email and the
   * team's push); the other clients offered it are emailed that it's taken (S37).
   */
  async claim(slug: TenantSlug, token: OfferToken): Promise<BookingConfirmResponse> {
    const claimed = await claimWaitlistOffer(this.db, slug, token, {
      templateRuleDefaults,
      notify: this.notify,
      tellTaken: this.emails.waitlistTaken,
    });
    return { booking: claimed.booking, manageToken: claimed.manageToken };
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
