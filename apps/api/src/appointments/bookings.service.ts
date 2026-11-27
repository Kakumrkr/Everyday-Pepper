import {
  addToWaitlist,
  cancelFollowing,
  changeBooking,
  createSeries,
  getSeries,
  listVisitNumbers,
  previewSeries,
  changeWaitlistEntry,
  createBooking,
  createWalkInBooking,
  findAvailability,
  getBooking,
  listBookings,
  listWaitlistOffers,
  listBusyTimes,
  listWaitlist,
} from '@pepper/appointments';
import type {
  AvailabilityQueryInput,
  AvailableSlot,
  Booking,
  BookingChange,
  BookingId,
  BookingInput,
  BookingSeries,
  BookingSeriesId,
  BookingSeriesInput,
  BookingSeriesPreview,
  BookingSeriesPreviewInput,
  BookingSeriesResult,
  BookingsQuery,
  CancelFollowingInput,
  CancelFollowingResult,
  BusyQuery,
  BusyTime,
  VisitNumbersResponse,
  WaitlistChange,
  WaitlistEntry,
  WaitlistEntryId,
  WaitlistEntryInput,
  WaitlistOffer,
  WaitlistQuery,
  WalkInBookingInput,
} from '@pepper/contracts';
import type { Actor, TenantContext } from '@pepper/core';
import { proposeNoShowFeeIn } from '@pepper/ai';
import type { Database, TenantTx } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PaymentsService } from '../payments/payments.service.js';
import { BookingEmails } from '../booking-emails/booking-emails.js';
import { ChatService } from '../chat/chat.service.js';

/**
 * The bookings, availability and waitlist services for a request: binds the database, the
 * request id (for the audit log), the industry templates' rule defaults (ADR-0018) and the
 * client's emails, queued with each change when `notifyClient` (ADR-0025). Domain errors pass
 * through; the controller answers them.
 */
@Injectable()
export class BookingsService {
  private readonly db: Database;
  private readonly logger = new Logger(BookingsService.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    private readonly emails: BookingEmails,
    // S66: the team's cancel refunds a paid deposit (AC-X-118); absent while payments are off.
    @Optional() private readonly payments?: PaymentsService,
    // S68: the team's no-show proposes the fee card the client's terms allow (AC-X-137).
    @Optional() private readonly chat?: ChatService,
  ) {
    this.db = database.db;
  }

  bookings(tenant: TenantContext, query: BookingsQuery, limit: number): Promise<Booking[]> {
    return listBookings(this.db, actorOf(tenant), query, { limit });
  }

  booking(tenant: TenantContext, id: BookingId): Promise<Booking> {
    return getBooking(this.db, actorOf(tenant), id);
  }

  createBooking(tenant: TenantContext, input: BookingInput): Promise<Booking> {
    return createBooking(this.db, actorOf(tenant), input, {
      templateRuleDefaults,
      notify: this.emails.notify,
    });
  }

  createWalkInBooking(tenant: TenantContext, input: WalkInBookingInput): Promise<Booking> {
    return createWalkInBooking(this.db, actorOf(tenant), input, {
      templateRuleDefaults,
      notify: this.emails.notify,
    });
  }

  async changeBooking(
    tenant: TenantContext,
    id: BookingId,
    change: BookingChange,
  ): Promise<Booking> {
    const noShow = 'status' in change && change.status === 'no_show';
    const deps =
      noShow && this.payments?.offered === true ? await this.chat?.toolDeps(tenant) : undefined;
    return changeBooking(this.db, actorOf(tenant), id, change, {
      templateRuleDefaults,
      notify: this.emails.notify,
      onCancelled: this.payments?.teamCancelled(),
      onMoved: this.payments?.teamMoved(),
      ...(deps !== undefined && {
        onNoShow: async (tx: TenantTx, booking: { bookingId: string }) => {
          await proposeNoShowFeeIn(tx, deps, booking.bookingId, {
            // Its name only: an error's message can hold a client's details.
            onUnexpected: (error) => {
              this.logger.error(
                `No-show fee card not made: ${error instanceof Error ? error.name : 'unknown'}`,
              );
            },
          });
        },
      }),
    });
  }

  /** Every date of a repeat, checked; nothing booked (S72, AC-X-182). */
  previewSeries(
    tenant: TenantContext,
    input: BookingSeriesPreviewInput,
  ): Promise<BookingSeriesPreview> {
    return previewSeries(this.db, actorOf(tenant), input, { templateRuleDefaults });
  }

  /** Books the free dates of a series, with one email to the client (S72, AC-X-183). */
  createSeries(tenant: TenantContext, input: BookingSeriesInput): Promise<BookingSeriesResult> {
    return createSeries(this.db, actorOf(tenant), input, {
      templateRuleDefaults,
      notify: this.emails.notifySeries,
    });
  }

  series(tenant: TenantContext, id: BookingSeriesId): Promise<BookingSeries> {
    return getSeries(this.db, actorOf(tenant), id);
  }

  /** "2 of 8" for the series visits of a range (S72.2, AC-X-193). */
  visitNumbers(tenant: TenantContext, query: BusyQuery): Promise<VisitNumbersResponse> {
    return listVisitNumbers(this.db, actorOf(tenant), query);
  }

  /** This visit and the later ones of its series (S72, D-3): each cancel as the team's. */
  cancelFollowing(
    tenant: TenantContext,
    id: BookingId,
    input: CancelFollowingInput,
  ): Promise<CancelFollowingResult> {
    return cancelFollowing(this.db, actorOf(tenant), id, input, {
      templateRuleDefaults,
      notify: this.emails.notifySeries,
      onCancelled: this.payments?.teamCancelled(),
    });
  }

  busy(tenant: TenantContext, query: BusyQuery, limit: number): Promise<BusyTime[]> {
    return listBusyTimes(this.db, actorOf(tenant), query, { limit });
  }

  availability(
    tenant: TenantContext,
    query: AvailabilityQueryInput,
    limit: number,
  ): Promise<AvailableSlot[]> {
    return findAvailability(this.db, actorOf(tenant), query, { templateRuleDefaults, limit });
  }

  /** The latest waitlist offers and their state (S37). */
  waitlistOffers(tenant: TenantContext): Promise<WaitlistOffer[]> {
    return listWaitlistOffers(this.db, actorOf(tenant));
  }

  waitlist(tenant: TenantContext, query: WaitlistQuery): Promise<WaitlistEntry[]> {
    return listWaitlist(this.db, actorOf(tenant), query);
  }

  addToWaitlist(tenant: TenantContext, input: WaitlistEntryInput): Promise<WaitlistEntry> {
    return addToWaitlist(this.db, actorOf(tenant), input, {
      templateRuleDefaults,
      optIn: this.emails.waitlistOptIn,
    });
  }

  changeWaitlistEntry(
    tenant: TenantContext,
    id: WaitlistEntryId,
    change: WaitlistChange,
  ): Promise<WaitlistEntry> {
    return changeWaitlistEntry(this.db, actorOf(tenant), id, change);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
