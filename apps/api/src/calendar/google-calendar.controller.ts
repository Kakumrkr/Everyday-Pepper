import {
  BookingCalendarStateSchema,
  BookingIdSchema,
  BusyQuerySchema,
  CalendarConnectCompleteSchema,
  CalendarConnectionAnswerSchema,
  CalendarConnectStartSchema,
  MAX_LIST_ITEMS,
  OutsideBusyResponseSchema,
  TeamCalendarConnectionsSchema,
  type BookingCalendarState,
  type CalendarConnectionAnswer,
  type CalendarConnectStart,
  type OutsideBusyResponse,
  type TeamCalendarConnections,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { z } from 'zod';
import { apiError, CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';
import {
  GOOGLE_CALENDAR_OPTIONS,
  GoogleCalendarService,
  type GoogleCalendarOptions,
} from './google-calendar.service.js';

// Google Calendar (S70, ADR-0069, AC-X-152…159). Every member may connect their own staff
// member's calendar (`calendar.read`, which everyone has); nobody connects someone else's. Off:
// the connection routes are 404 `calendar_off`.

const BookingParamsSchema = z.object({ bookingId: BookingIdSchema });

/** Each connect asks Google once or twice; a member needs a handful at most. */
const MEMBER_CALLS: RateLimit = { name: 'calendar-connect', max: 20, windowSeconds: 600 };

@Controller('v1/calendar')
@UseGuards(TenantGuard)
export class GoogleCalendarController {
  constructor(
    private readonly calendar: GoogleCalendarService,
    private readonly limits: RateLimiter,
  ) {}

  /** 200 the member's own connection and whether they can connect (AC-X-152); 404 off. */
  @Get('google')
  @RequirePermission('calendar.read')
  async own(@CurrentTenant() tenant: TenantContext): Promise<CalendarConnectionAnswer> {
    return CalendarConnectionAnswerSchema.parse(await answering(() => this.calendar.own(tenant)));
  }

  /**
   * 200 every staff member's calendar state for the Team list (S70.2, AC-X-164, AC-X-165):
   * status and last read, never the account's email; `staff.read`, like the list; 404 off.
   */
  @Get('connections')
  @RequirePermission('staff.read')
  async team(@CurrentTenant() tenant: TenantContext): Promise<TeamCalendarConnections> {
    return TeamCalendarConnectionsSchema.parse(
      await answering(() => this.calendar.team(tenant, MAX_LIST_ITEMS)),
    );
  }

  /** 200 Google's consent page to send the member to; 409 `calendar_not_linked`; 429; 404 off. */
  @Post('google/connect')
  @HttpCode(200)
  @RequirePermission('calendar.read')
  async connect(@CurrentTenant() tenant: TenantContext): Promise<CalendarConnectStart> {
    await this.limits.hit(MEMBER_CALLS, `${tenant.tenantId}:${tenant.userId}`);
    return CalendarConnectStartSchema.parse(await answering(() => this.calendar.connect(tenant)));
  }

  /**
   * 200 the connection, read once (AC-X-152, AC-X-155); 400 `calendar_connect_invalid` (the
   * state is unknown, used, expired or another member's, or Google refused the code); 409
   * `calendar_scope_missing`; 503 `calendar_unavailable`; 429; 404 off.
   */
  @Post('google/callback')
  @HttpCode(200)
  @RequirePermission('calendar.read')
  async complete(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<CalendarConnectionAnswer> {
    await this.limits.hit(MEMBER_CALLS, `${tenant.tenantId}:${tenant.userId}`);
    const input = parseBody(CalendarConnectCompleteSchema, body);
    return CalendarConnectionAnswerSchema.parse(
      await answering(() => this.calendar.complete(tenant, input)),
    );
  }

  /** 204 disconnected and revoked (AC-X-157); 404 `calendar_not_connected`; 404 off. */
  @Delete('google')
  @HttpCode(204)
  @RequirePermission('calendar.read')
  async disconnect(@CurrentTenant() tenant: TenantContext): Promise<void> {
    await answering(() => this.calendar.disconnect(tenant));
  }

  /**
   * 200 whether a booking is in Google Calendar, for its sheet (S71 top-up, AC-X-173):
   * `written`, `pending` or `none`; 404 `booking_not_found` for a booking the member can't see
   * (another business's, or a colleague's for staff); 404 off.
   */
  @Get('bookings/:bookingId')
  @RequirePermission('calendar.read')
  async bookingState(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<BookingCalendarState> {
    const { bookingId } = parseBody(BookingParamsSchema, params);
    const state = await answering(() => this.calendar.bookingState(tenant, bookingId));
    if (state === undefined) throw new NotFoundException(apiError('booking_not_found'));
    return BookingCalendarStateSchema.parse(state);
  }

  /**
   * Busy times from staff members' outside calendars (AC-X-159): when, never what, capped like
   * booked times. Read whether or not the provider is on.
   */
  @Get('outside-busy')
  @RequirePermission('calendar.read')
  async outsideBusy(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<OutsideBusyResponse> {
    const parsed = parseBody(BusyQuerySchema, query);
    const rows = await answering(() =>
      this.calendar.outsideBusy(tenant, parsed, MAX_LIST_ITEMS + 1),
    );
    return OutsideBusyResponseSchema.parse({
      busy: rows.slice(0, MAX_LIST_ITEMS),
      truncated: rows.length > MAX_LIST_ITEMS,
    });
  }
}

@Module({})
export class GoogleCalendarModule {
  static forRoot(options: GoogleCalendarOptions): DynamicModule {
    return {
      module: GoogleCalendarModule,
      controllers: [GoogleCalendarController],
      providers: [
        { provide: GOOGLE_CALENDAR_OPTIONS, useValue: options },
        RateLimiter,
        GoogleCalendarService,
      ],
    };
  }
}
