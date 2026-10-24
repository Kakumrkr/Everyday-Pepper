import {
  AvailabilityQuerySchema,
  BookingConfirmInputSchema,
  BookingRequestIdSchema,
  BookingRequestInputSchema,
  ManageBookingInputSchema,
  MAX_LIST_ITEMS,
  OfferTokenInputSchema,
  PublicRescheduleInputSchema,
  TenantSlugSchema,
  type AvailabilityResponse,
  type BookingConfirmResponse,
  type BookingRequestResponse,
  type PublicBookingResponse,
  type PublicBusiness,
  type PublicOfferResponse,
} from '@pepper/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { capped } from '../appointments/bookings.controller.js';
import { answering } from '../http/domain-errors.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';
import { PublicBookingService } from './public-booking.service.js';

// Limits for anonymous callers (ADR-0022). Per address: generous for people, tight for
// scripts. Per business: the code emails it may send an hour, which no caller can spread
// over addresses.
const PAGE_READS: RateLimit = { name: 'page-read', max: 120, windowSeconds: 60 };
const REQUESTS_PER_ADDRESS: RateLimit = { name: 'request-ip', max: 10, windowSeconds: 600 };
const REQUESTS_PER_BUSINESS: RateLimit = { name: 'request-biz', max: 100, windowSeconds: 3600 };
const CODE_CHECKS: RateLimit = { name: 'confirm-ip', max: 30, windowSeconds: 600 };
const LINK_USES: RateLimit = { name: 'link-ip', max: 30, windowSeconds: 600 };
// Waitlist claims (S37): a person claims once or twice; a script trying secrets is stopped.
const OFFER_CLAIMS: RateLimit = { name: 'claim-ip', max: 10, windowSeconds: 600 };

const SlugParamsSchema = z.object({ slug: z.string() });
const RequestParamsSchema = z.object({ slug: z.string(), requestId: BookingRequestIdSchema });

type IncomingRequest = Parameters<typeof clientAddress>[0];

/**
 * The public booking page (W8, ADR-0022): no session; the business comes from the slug in the
 * URL. A booking is made only after the client types the code emailed to them (AC-W8-2); its
 * reschedule/cancel link carries a secret, sent in POST bodies. Writes still need the app's
 * `Origin` (the page is served by the web app). An unknown slug is 404
 * `booking_page_not_found`; a malformed one is the same, so slugs cannot be probed apart.
 */
@Controller('v1/public/businesses/:slug')
export class PublicBookingController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly limits: RateLimiter,
  ) {}

  /** The page: name, color, the services someone offers and who offers them. */
  @Get()
  async business(
    @Param() params: unknown,
    @Req() request: IncomingRequest,
  ): Promise<PublicBusiness> {
    const { slug } = parseBody(SlugParamsSchema, params);
    await this.limits.hit(PAGE_READS, clientAddress(request));
    return answering(() => this.booking.business(slug));
  }

  /** Free start times (at most 62 days); with no staff member, one per time for anyone. */
  @Get('availability')
  async availability(
    @Param() params: unknown,
    @Query() query: unknown,
    @Req() request: IncomingRequest,
  ): Promise<AvailabilityResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const parsed = parseBody(AvailabilityQuerySchema, query);
    await this.limits.hit(PAGE_READS, clientAddress(request));
    const [slots, truncated] = capped(
      await answering(() => this.booking.availability(slug, parsed, MAX_LIST_ITEMS + 1)),
    );
    return { slots, truncated };
  }

  /**
   * 201: a code is on its way to the email address; nothing is booked yet. 409
   * `slot_unavailable` with alternatives; 429 `too_many_requests`; 503 `email_unavailable`.
   */
  @Post('booking-requests')
  async request(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<BookingRequestResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const input = parseBody(BookingRequestInputSchema, body);
    await this.limits.hit(REQUESTS_PER_ADDRESS, clientAddress(request));
    await this.limits.hit(REQUESTS_PER_BUSINESS, pageKey(slug));
    return answering(() => this.booking.request(slug, input));
  }

  /**
   * 201: booked, with the secret of the reschedule/cancel link (also emailed). 422
   * `wrong_code` with `attemptsLeft`; 410 `booking_request_expired`; 409
   * `booking_request_used` or `slot_unavailable` with alternatives, one of which the same
   * code may then confirm (`startsAt`).
   */
  @Post('booking-requests/:requestId/confirm')
  async confirm(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<BookingConfirmResponse> {
    const { slug, requestId } = parseBody(RequestParamsSchema, params);
    const input = parseBody(BookingConfirmInputSchema, body);
    await this.limits.hit(CODE_CHECKS, clientAddress(request));
    return answering(() => this.booking.confirm(slug, requestId, input));
  }

  /** The booking behind a link; 404 `booking_not_found` for an unknown token. */
  @Post('booking/lookup')
  @HttpCode(200)
  async lookup(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<PublicBookingResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const { token } = parseBody(ManageBookingInputSchema, body);
    await this.limits.hit(LINK_USES, clientAddress(request));
    return { booking: await answering(() => this.booking.managed(slug, token)) };
  }

  /**
   * Moves the booking to another free time with the same staff member. 409
   * `slot_unavailable` with alternatives, or `booking_not_changeable` once it has started or
   * was cancelled.
   */
  @Post('booking/reschedule')
  @HttpCode(200)
  async reschedule(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<PublicBookingResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const { token, startsAt } = parseBody(PublicRescheduleInputSchema, body);
    await this.limits.hit(LINK_USES, clientAddress(request));
    return { booking: await answering(() => this.booking.reschedule(slug, token, startsAt)) };
  }

  /**
   * The waitlist offer behind a claim link (S37): its time and whether it is still open. 404
   * `waitlist_offer_not_found` for an unknown secret. Reading changes nothing.
   */
  @Post('waitlist-offer/lookup')
  @HttpCode(200)
  async offer(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<PublicOfferResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const { token } = parseBody(OfferTokenInputSchema, body);
    await this.limits.hit(LINK_USES, clientAddress(request));
    return { offer: await answering(() => this.booking.offer(slug, token)) };
  }

  /**
   * Claims the offer: the first claim books the time (200, the booking and its own
   * reschedule/cancel secret). 409 `waitlist_offer_taken` when someone else claimed it first or
   * it was booked meanwhile, 409 `waitlist_offer_used` for a link already used, 410
   * `waitlist_offer_expired` past its time. None says who holds the time.
   */
  @Post('waitlist-offer/claim')
  @HttpCode(200)
  async claim(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<BookingConfirmResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const { token } = parseBody(OfferTokenInputSchema, body);
    await this.limits.hit(OFFER_CLAIMS, clientAddress(request));
    return answering(() => this.booking.claim(slug, token));
  }

  /** Cancels the booking; 409 `booking_not_changeable` once it has started or was cancelled. */
  @Post('booking/cancel')
  @HttpCode(200)
  async cancel(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<PublicBookingResponse> {
    const { slug } = parseBody(SlugParamsSchema, params);
    const { token } = parseBody(ManageBookingInputSchema, body);
    await this.limits.hit(LINK_USES, clientAddress(request));
    return { booking: await answering(() => this.booking.cancel(slug, token)) };
  }
}

/** One counter per business; a malformed slug shares one (it is refused anyway). */
function pageKey(slug: string): string {
  return TenantSlugSchema.safeParse(slug).success ? slug : '-';
}
