import {
  addTimeOff,
  createService,
  createStaffMember,
  getBookingRules,
  getWorkingHours,
  listServices,
  listStaff,
  listTimeOff,
  removeTimeOff,
  replaceBookingRules,
  replaceWorkingHours,
  updateService,
  updateStaffMember,
} from '@pepper/appointments';
import type {
  BookingRules,
  BookingRulesInput,
  Service,
  ServiceId,
  ServiceInput,
  StaffMember,
  StaffMemberId,
  StaffMemberInput,
  TimeOff,
  TimeOffId,
  TimeOffInput,
  TimeOffQuery,
  WeeklyHours,
  WeeklyHoursInput,
} from '@pepper/contracts';
import type { Actor, TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/**
 * The appointments module's services for a request: binds the database and the request id (for
 * the audit log). Domain errors pass through; the controller answers them.
 */
@Injectable()
export class AppointmentsService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  services(tenant: TenantContext): Promise<Service[]> {
    return listServices(this.db, actorOf(tenant));
  }

  createService(tenant: TenantContext, input: ServiceInput): Promise<Service> {
    return createService(this.db, actorOf(tenant), input);
  }

  updateService(tenant: TenantContext, id: ServiceId, input: ServiceInput): Promise<Service> {
    return updateService(this.db, actorOf(tenant), id, input);
  }

  staff(tenant: TenantContext): Promise<StaffMember[]> {
    return listStaff(this.db, actorOf(tenant));
  }

  createStaffMember(tenant: TenantContext, input: StaffMemberInput): Promise<StaffMember> {
    return createStaffMember(this.db, actorOf(tenant), input);
  }

  updateStaffMember(
    tenant: TenantContext,
    id: StaffMemberId,
    input: StaffMemberInput,
  ): Promise<StaffMember> {
    return updateStaffMember(this.db, actorOf(tenant), id, input);
  }

  hours(tenant: TenantContext, id: StaffMemberId): Promise<WeeklyHours> {
    return getWorkingHours(this.db, actorOf(tenant), id);
  }

  replaceHours(
    tenant: TenantContext,
    id: StaffMemberId,
    input: WeeklyHoursInput,
  ): Promise<WeeklyHours> {
    return replaceWorkingHours(this.db, actorOf(tenant), id, input);
  }

  timeOff(tenant: TenantContext, id: StaffMemberId, query: TimeOffQuery): Promise<TimeOff[]> {
    return listTimeOff(this.db, actorOf(tenant), id, query);
  }

  addTimeOff(tenant: TenantContext, id: StaffMemberId, input: TimeOffInput): Promise<TimeOff> {
    return addTimeOff(this.db, actorOf(tenant), id, input);
  }

  removeTimeOff(tenant: TenantContext, id: StaffMemberId, timeOffId: TimeOffId): Promise<void> {
    return removeTimeOff(this.db, actorOf(tenant), id, timeOffId);
  }

  rules(tenant: TenantContext): Promise<BookingRules> {
    return getBookingRules(this.db, actorOf(tenant));
  }

  replaceRules(tenant: TenantContext, input: BookingRulesInput): Promise<BookingRules> {
    return replaceBookingRules(this.db, actorOf(tenant), input);
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
