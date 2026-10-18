import {
  addToWaitlist,
  changeBooking,
  changeWaitlistEntry,
  createBooking,
  findAvailability,
  getBooking,
  listBookings,
  listBusyTimes,
  listWaitlist,
} from '@floty/appointments';
import type {
  AvailabilityQueryInput,
  AvailableSlot,
  Booking,
  BookingChange,
  BookingId,
  BookingInput,
  BookingsQuery,
  BusyQuery,
  BusyTime,
  WaitlistChange,
  WaitlistEntry,
  WaitlistEntryId,
  WaitlistEntryInput,
  WaitlistQuery,
} from '@floty/contracts';
import type { Actor, TenantContext } from '@floty/core';
import type { Database } from '@floty/db';
import { currentRequestContext, DATABASE } from '@floty/runtime';
import { templateRuleDefaults } from '@floty/templates';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The bookings, availability and waitlist services for a request: binds the database, the
 * request id (for the audit log) and the industry templates' rule defaults (ADR-0018). Domain
 * errors pass through; the controller answers them.
 */
@Injectable()
export class BookingsService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  bookings(tenant: TenantContext, query: BookingsQuery, limit: number): Promise<Booking[]> {
    return listBookings(this.db, actorOf(tenant), query, { limit });
  }

  booking(tenant: TenantContext, id: BookingId): Promise<Booking> {
    return getBooking(this.db, actorOf(tenant), id);
  }

  createBooking(tenant: TenantContext, input: BookingInput): Promise<Booking> {
    return createBooking(this.db, actorOf(tenant), input, { templateRuleDefaults });
  }

  changeBooking(tenant: TenantContext, id: BookingId, change: BookingChange): Promise<Booking> {
    return changeBooking(this.db, actorOf(tenant), id, change, { templateRuleDefaults });
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

  waitlist(tenant: TenantContext, query: WaitlistQuery): Promise<WaitlistEntry[]> {
    return listWaitlist(this.db, actorOf(tenant), query);
  }

  addToWaitlist(tenant: TenantContext, input: WaitlistEntryInput): Promise<WaitlistEntry> {
    return addToWaitlist(this.db, actorOf(tenant), input);
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
