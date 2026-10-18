import {
  BookingRulesSchema,
  ServiceIdSchema,
  ServiceInputSchema,
  StaffMemberIdSchema,
  StaffMemberInputSchema,
  TimeOffIdSchema,
  TimeOffInputSchema,
  TimeOffQuerySchema,
  WeeklyHoursSchema,
  type BookingRulesResponse,
  type Service,
  type ServicesResponse,
  type StaffMember,
  type StaffResponse,
  type TimeOff,
  type TimeOffResponse,
  type WeeklyHours,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { AppointmentsService } from './appointments.service.js';

const ServiceParamsSchema = z.object({ serviceId: ServiceIdSchema });
const StaffParamsSchema = z.object({ staffMemberId: StaffMemberIdSchema });
const TimeOffParamsSchema = StaffParamsSchema.extend({ timeOffId: TimeOffIdSchema });

/**
 * The appointments data of the active business: `/v1/services` and `/v1/staff` with each
 * staff member's `hours` and `time-off` (ADR-0015), and its booking rules, `/v1/rules`
 * (ADR-0016). Route guards check the permission at all; the domain services check it again,
 * on the record where it is scoped (a staff member's own time off), and write the audit
 * entries.
 */
@Controller('v1')
@UseGuards(TenantGuard)
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Get('services')
  @RequirePermission('services.read')
  async services(@CurrentTenant() tenant: TenantContext): Promise<ServicesResponse> {
    return { services: await answering(() => this.appointments.services(tenant)) };
  }

  /** 201 the service; 409 `service_name_taken`. */
  @Post('services')
  @RequirePermission('services.manage')
  createService(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<Service> {
    const input = parseBody(ServiceInputSchema, body);
    return answering(() => this.appointments.createService(tenant, input));
  }

  /** Replaces all fields. 404 `service_not_found`, 409 `service_name_taken`. */
  @Put('services/:serviceId')
  @RequirePermission('services.manage')
  updateService(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<Service> {
    const { serviceId } = parseBody(ServiceParamsSchema, params);
    const input = parseBody(ServiceInputSchema, body);
    return answering(() => this.appointments.updateService(tenant, serviceId, input));
  }

  @Get('staff')
  @RequirePermission('staff.read')
  async staff(@CurrentTenant() tenant: TenantContext): Promise<StaffResponse> {
    return { staff: await answering(() => this.appointments.staff(tenant)) };
  }

  /**
   * 201 the staff member; 404 `member_not_found` (login of a non-member) or
   * `service_not_found`; 409 `staff_member_link_taken`.
   */
  @Post('staff')
  @RequirePermission('staff.manage')
  createStaffMember(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<StaffMember> {
    const input = parseBody(StaffMemberInputSchema, body);
    return answering(() => this.appointments.createStaffMember(tenant, input));
  }

  /** Replaces all fields, the login link and the services. Errors as for POST, plus 404. */
  @Put('staff/:staffMemberId')
  @RequirePermission('staff.manage')
  updateStaffMember(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<StaffMember> {
    const { staffMemberId } = parseBody(StaffParamsSchema, params);
    const input = parseBody(StaffMemberInputSchema, body);
    return answering(() => this.appointments.updateStaffMember(tenant, staffMemberId, input));
  }

  @Get('staff/:staffMemberId/hours')
  @RequirePermission('staff.read')
  hours(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<WeeklyHours> {
    const { staffMemberId } = parseBody(StaffParamsSchema, params);
    return answering(() => this.appointments.hours(tenant, staffMemberId));
  }

  /** Replaces the whole week (local time). 404 `staff_member_not_found`. */
  @Put('staff/:staffMemberId/hours')
  @RequirePermission('hours.manage')
  replaceHours(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<WeeklyHours> {
    const { staffMemberId } = parseBody(StaffParamsSchema, params);
    const hours = parseBody(WeeklyHoursSchema, body);
    return answering(() => this.appointments.replaceHours(tenant, staffMemberId, hours));
  }

  @Get('staff/:staffMemberId/time-off')
  @RequirePermission('staff.read')
  async timeOff(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Query() query: unknown,
  ): Promise<TimeOffResponse> {
    const { staffMemberId } = parseBody(StaffParamsSchema, params);
    const parsed = parseBody(TimeOffQuerySchema, query);
    return {
      timeOff: await answering(() => this.appointments.timeOff(tenant, staffMemberId, parsed)),
    };
  }

  /** 201 the entry. Staff may add only their own (403 `forbidden`). */
  @Post('staff/:staffMemberId/time-off')
  @RequirePermission('time_off.manage')
  addTimeOff(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<TimeOff> {
    const { staffMemberId } = parseBody(StaffParamsSchema, params);
    const input = parseBody(TimeOffInputSchema, body);
    return answering(() => this.appointments.addTimeOff(tenant, staffMemberId, input));
  }

  /** Staff may remove only their own (403 `forbidden`); 404 `time_off_not_found`. */
  @Delete('staff/:staffMemberId/time-off/:timeOffId')
  @RequirePermission('time_off.manage')
  @HttpCode(204)
  async removeTimeOff(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<void> {
    const { staffMemberId, timeOffId } = parseBody(TimeOffParamsSchema, params);
    await answering(() => this.appointments.removeTimeOff(tenant, staffMemberId, timeOffId));
  }

  @Get('rules')
  @RequirePermission('rules.read')
  rules(@CurrentTenant() tenant: TenantContext): Promise<BookingRulesResponse> {
    return answering(() => this.appointments.rules(tenant));
  }

  /** Replaces the whole rule set. 404 `staff_member_not_found` for a rule's staff member. */
  @Put('rules')
  @RequirePermission('rules.manage')
  replaceRules(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<BookingRulesResponse> {
    const rules = parseBody(BookingRulesSchema, body);
    return answering(() => this.appointments.replaceRules(tenant, rules));
  }
}
