import {
  AvailabilityQuerySchema,
  BookingChangeSchema,
  BookingIdSchema,
  BookingInputSchema,
  BookingSeriesIdSchema,
  BookingSeriesInputSchema,
  BookingSeriesPreviewInputSchema,
  BookingsQuerySchema,
  CancelFollowingInputSchema,
  BusyQuerySchema,
  MAX_LIST_ITEMS,
  WaitlistChangeSchema,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistQuerySchema,
  WalkInBookingInputSchema,
  type AvailabilityResponse,
  type Booking,
  type BookingSeries,
  type BookingSeriesPreview,
  type BookingSeriesResult,
  type BookingsResponse,
  type CancelFollowingResult,
  type BusyResponse,
  type WaitlistEntry,
  type WaitlistOffersResponse,
  type WaitlistResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { BookingsService } from './bookings.service.js';

const BookingParamsSchema = z.object({ bookingId: BookingIdSchema });
const WaitlistParamsSchema = z.object({ entryId: WaitlistEntryIdSchema });
const SeriesParamsSchema = z.object({ seriesId: BookingSeriesIdSchema });

/**
 * Bookings, the team's busy times, availability and the waitlist of the active business
 * (ADR-0017). Staff reach only their own staff member's bookings and waitlist entries
 * (AC-W9-1): the domain services check it and the database's member scope enforces it, so
 * another's booking is simply not found. Everyone sees busy times and availability.
 */
@Controller('v1')
@UseGuards(TenantGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /**
   * Bookings whose appointment overlaps [from, to) (at most 62 days), by start; at most
   * `MAX_LIST_ITEMS`, with `truncated` when more exist.
   */
  @Get('bookings')
  @RequirePermission('bookings.read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<BookingsResponse> {
    const parsed = parseBody(BookingsQuerySchema, query);
    const [bookings, truncated] = capped(
      await answering(() => this.bookings.bookings(tenant, parsed, MAX_LIST_ITEMS + 1)),
    );
    return { bookings, truncated };
  }

  /** 404 `booking_not_found`. */
  @Get('bookings/:bookingId')
  @RequirePermission('bookings.read')
  get(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<Booking> {
    const { bookingId } = parseBody(BookingParamsSchema, params);
    return answering(() => this.bookings.booking(tenant, bookingId));
  }

  /**
   * 201 the booking (or, for a retried `idempotencyKey`, the first one). 409
   * `slot_unavailable` with `alternatives`, or `idempotency_key_reused`; 404 for an unknown
   * client, service or staff member; 403 when staff book someone else or override.
   */
  @Post('bookings')
  @RequirePermission('bookings.manage')
  create(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Booking> {
    const input = parseBody(BookingInputSchema, body);
    return answering(() => this.bookings.createBooking(tenant, input));
  }

  /**
   * A walk-in's booking (S50.2, ADR-0052): `client` (a name, an email or phone when given)
   * instead of `clientId`; the client and the booking are added together or not at all, and a
   * client with that email (or, without one, the one client with that phone) is booked instead
   * of a second. 201 the booking; the same refusals as `POST /v1/bookings`.
   */
  @Post('bookings/walk-in')
  @RequirePermission('bookings.manage')
  createWalkIn(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Booking> {
    const input = parseBody(WalkInBookingInputSchema, body);
    return answering(() => this.bookings.createWalkInBooking(tenant, input));
  }

  /**
   * A repeat's dates, each checked as one booking would be (S72, ADR-0070): free, or not with the
   * nearest free times and whether it is past the booking window. Nothing is booked. 403 when
   * staff ask about someone else.
   */
  @Post('bookings/series/preview')
  @HttpCode(200)
  @RequirePermission('bookings.manage')
  previewSeries(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<BookingSeriesPreview> {
    const input = parseBody(BookingSeriesPreviewInputSchema, body);
    return answering(() => this.bookings.previewSeries(tenant, input));
  }

  /**
   * Books a series (S72): 201 the booked visits and the skipped dates with alternatives (or, for
   * a retried `idempotencyKey`, the first answer). 409 `slot_unavailable` when no date is free,
   * or `idempotency_key_reused`; 403 when staff book someone else.
   */
  @Post('bookings/series')
  @RequirePermission('bookings.manage')
  createSeries(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<BookingSeriesResult> {
    const input = parseBody(BookingSeriesInputSchema, body);
    return answering(() => this.bookings.createSeries(tenant, input));
  }

  /** A series' visits, earliest first, any status; 404 `booking_not_found`. */
  @Get('bookings/series/:seriesId')
  @RequirePermission('bookings.read')
  series(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<BookingSeries> {
    const { seriesId } = parseBody(SeriesParamsSchema, params);
    return answering(() => this.bookings.series(tenant, seriesId));
  }

  /**
   * Cancels this visit and the later confirmed visits of its series (S72, D-3); a booking outside
   * a series alone. The refusals of a cancel by `PATCH /v1/bookings/:id`.
   */
  @Post('bookings/:bookingId/cancel-following')
  @HttpCode(200)
  @RequirePermission('bookings.manage')
  cancelFollowing(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<CancelFollowingResult> {
    const { bookingId } = parseBody(BookingParamsSchema, params);
    const input = parseBody(CancelFollowingInputSchema, body);
    return answering(() => this.bookings.cancelFollowing(tenant, bookingId, input));
  }

  /**
   * Moves the booking (`startsAt`, optional `staffMemberId`, `override`) or changes its status.
   * 409 `slot_unavailable` with `alternatives`, `booking_not_changeable` or
   * `booking_not_started`; 404 `booking_not_found`.
   */
  @Patch('bookings/:bookingId')
  @RequirePermission('bookings.manage')
  change(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Booking> {
    const { bookingId } = parseBody(BookingParamsSchema, params);
    const change = parseBody(BookingChangeSchema, body);
    return answering(() => this.bookings.changeBooking(tenant, bookingId, change));
  }

  /**
   * When each staff member is booked (buffers included), without booking details; capped like
   * bookings.
   */
  @Get('calendar/busy')
  @RequirePermission('calendar.read')
  async busy(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<BusyResponse> {
    const parsed = parseBody(BusyQuerySchema, query);
    const [busy, truncated] = capped(
      await answering(() => this.bookings.busy(tenant, parsed, MAX_LIST_ITEMS + 1)),
    );
    return { busy, truncated };
  }

  /**
   * Start times in [from, to) for a service, capped like bookings; 404 for an unknown service or
   * staff member.
   */
  @Get('availability')
  @RequirePermission('calendar.read')
  async availability(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<AvailabilityResponse> {
    const parsed = parseBody(AvailabilityQuerySchema, query);
    const [slots, truncated] = capped(
      await answering(() => this.bookings.availability(tenant, parsed, MAX_LIST_ITEMS + 1)),
    );
    return { slots, truncated };
  }

  /** Open entries (or `all=true`), longest waiting first. */
  @Get('waitlist')
  @RequirePermission('bookings.read')
  async waitlist(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<WaitlistResponse> {
    const parsed = parseBody(WaitlistQuerySchema, query);
    return { entries: await answering(() => this.bookings.waitlist(tenant, parsed)) };
  }

  /** The latest offers of freed times to the waitlist, newest first, with their state (S37). */
  @Get('waitlist/offers')
  @RequirePermission('bookings.read')
  async waitlistOffers(@CurrentTenant() tenant: TenantContext): Promise<WaitlistOffersResponse> {
    return { offers: await answering(() => this.bookings.waitlistOffers(tenant)) };
  }

  /**
   * 201 the entry; 400 `waitlist_expired` when every window has passed; 409
   * `waitlist_times_free` with the earliest free times when a window isn't full (S44).
   */
  @Post('waitlist')
  @RequirePermission('bookings.manage')
  addToWaitlist(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<WaitlistEntry> {
    const input = parseBody(WaitlistEntryInputSchema, body);
    return answering(() => this.bookings.addToWaitlist(tenant, input));
  }

  /** Cancels the entry. 409 `waitlist_entry_not_changeable`; 404 `waitlist_entry_not_found`. */
  @Patch('waitlist/:entryId')
  @RequirePermission('bookings.manage')
  changeWaitlistEntry(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<WaitlistEntry> {
    const { entryId } = parseBody(WaitlistParamsSchema, params);
    const change = parseBody(WaitlistChangeSchema, body);
    return answering(() => this.bookings.changeWaitlistEntry(tenant, entryId, change));
  }
}

/** The first `MAX_LIST_ITEMS` of up to one more, and whether there were more. */
export function capped<T>(items: readonly T[]): [T[], boolean] {
  return [items.slice(0, MAX_LIST_ITEMS), items.length > MAX_LIST_ITEMS];
}
