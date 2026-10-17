import {
  AvailabilityQuerySchema,
  BookingChangeSchema,
  BookingIdSchema,
  BookingInputSchema,
  BookingsQuerySchema,
  BusyQuerySchema,
  WaitlistChangeSchema,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistQuerySchema,
  type AvailabilityResponse,
  type Booking,
  type BookingsResponse,
  type BusyResponse,
  type WaitlistEntry,
  type WaitlistResponse,
} from '@floty/contracts';
import type { TenantContext } from '@floty/core';
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { BookingsService } from './bookings.service.js';

const BookingParamsSchema = z.object({ bookingId: BookingIdSchema });
const WaitlistParamsSchema = z.object({ entryId: WaitlistEntryIdSchema });

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

  /** Bookings whose appointment overlaps [from, to) (at most 62 days), by start. */
  @Get('bookings')
  @RequirePermission('bookings.read')
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<BookingsResponse> {
    const parsed = parseBody(BookingsQuerySchema, query);
    return { bookings: await answering(() => this.bookings.bookings(tenant, parsed)) };
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

  /** When each staff member is booked (buffers included), without booking details. */
  @Get('calendar/busy')
  @RequirePermission('calendar.read')
  async busy(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<BusyResponse> {
    const parsed = parseBody(BusyQuerySchema, query);
    return { busy: await answering(() => this.bookings.busy(tenant, parsed)) };
  }

  /** Start times in [from, to) for a service; 404 for an unknown service or staff member. */
  @Get('availability')
  @RequirePermission('calendar.read')
  async availability(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<AvailabilityResponse> {
    const parsed = parseBody(AvailabilityQuerySchema, query);
    return { slots: await answering(() => this.bookings.availability(tenant, parsed)) };
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

  /** 201 the entry; 400 `waitlist_expired` when every window has passed. */
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
