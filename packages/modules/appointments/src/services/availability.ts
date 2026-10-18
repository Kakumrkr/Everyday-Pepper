import {
  AvailabilityQuerySchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TemplateIdSchema,
  type AvailabilityQueryInput,
  type AvailableSlot,
  type RuleDefaults,
  type StaffMemberId,
  type TemplateId,
} from '@floty/contracts';
import { requirePermission, systemClock, type Actor, type Clock } from '@floty/core';
import {
  findCurrentTenant,
  findService,
  listBookingRules,
  listOccupancy,
  listStaffMembers,
  listTimeOffBetween,
  listWorkingHoursOf,
  withMember,
  type Database,
  type ServiceRow,
  type TenantTx,
} from '@floty/db';
import { availableSlots, type ServiceToBook, type Slot } from '../availability/engine.js';
import { LOAD_MARGIN_MS, staffAvailabilityOf, toAvailableSlot } from '../bookings/planning.js';
import { ServiceNotFoundError, StaffMemberNotFoundError } from '../errors.js';
import { rowsToRules } from '../mapping.js';

// When a service can be booked (ADR-0016, ADR-0017): the availability engine over the stored
// hours, time off, booking rules and the occupied time of active bookings. Everyone in the
// business may ask (`calendar.read`): occupied times carry no booking details, so staff get
// the same answer as owners. Booking itself re-runs the same check under a lock.

/**
 * The booking rule defaults of the business's industry template (ADR-0016's "template" step,
 * ADR-0018). The app passes `templateRuleDefaults` from `@floty/templates`: modules (L2) do not
 * import templates (L3). Without it, only the platform defaults apply.
 */
export type TemplateRuleDefaultsOf = (templateId: TemplateId | null) => Partial<RuleDefaults>;

/** Start times in [from, to) for the service, with one staff member or anyone who offers it. */
export async function findAvailability(
  db: Database,
  actor: Actor,
  query: AvailabilityQueryInput,
  options: { clock?: Clock; templateRuleDefaults?: TemplateRuleDefaultsOf } = {},
): Promise<AvailableSlot[]> {
  requirePermission(actor, 'calendar.read');
  const { serviceId, staffMemberId, from, to } = AvailabilityQuerySchema.parse(query);
  const now = (options.clock ?? systemClock).now().getTime();
  return withMember(db, actor.context, async (tx) => {
    const service = await findService(tx, serviceId);
    if (service === undefined) throw new ServiceNotFoundError();
    const slots = await slotsFor(tx, {
      service: serviceToBook(service),
      staffMemberIds: staffMemberId === undefined ? undefined : [staffMemberId],
      from: Date.parse(from),
      to: Date.parse(to),
      now,
      templateRuleDefaults: options.templateRuleDefaults,
    });
    return slots.map(toAvailableSlot);
  });
}

export interface SlotSearch {
  service: ServiceToBook;
  /** These staff members (`StaffMemberNotFoundError` for an unknown one); default: everyone. */
  staffMemberIds?: readonly StaffMemberId[] | undefined;
  from: number;
  to: number;
  now: number;
  /** A booking being moved: its own time does not block it. */
  excludeBookingId?: string;
  templateRuleDefaults?: TemplateRuleDefaultsOf | undefined;
}

/** The engine's slots for a search, from the transaction's data. */
export async function slotsFor(tx: TenantTx, search: SlotSearch): Promise<Slot[]> {
  const tenant = await findCurrentTenant(tx);
  // withMember always has a tenant; its row is visible to every member.
  if (tenant === undefined) throw new Error('No tenant in this transaction');
  const allStaff = await listStaffMembers(tx);
  const wanted =
    search.staffMemberIds === undefined
      ? undefined
      : new Set<string>(search.staffMemberIds.map((id) => StaffMemberIdSchema.parse(id)));
  const staff = wanted === undefined ? allStaff : allStaff.filter((s) => wanted.has(s.id));
  if (wanted !== undefined && staff.length !== wanted.size) throw new StaffMemberNotFoundError();
  const ids = staff.map((s) => StaffMemberIdSchema.parse(s.id));
  const around = {
    from: new Date(search.from - LOAD_MARGIN_MS),
    to: new Date(search.to + LOAD_MARGIN_MS),
  };
  const rules = rowsToRules(await listBookingRules(tx)).rules;
  const templateDefaults =
    search.templateRuleDefaults?.(TemplateIdSchema.nullable().parse(tenant.templateId)) ?? {};
  const hours = await listWorkingHoursOf(tx, ids);
  const timeOff = await listTimeOffBetween(tx, ids, around);
  const occupancy = await listOccupancy(tx, { ...around, staffMemberIds: ids });
  return availableSlots({
    timeZone: tenant.timeZone,
    now: search.now,
    from: search.from,
    to: search.to,
    service: search.service,
    staff: staff.map((s) =>
      staffAvailabilityOf({
        staff: s,
        hours,
        timeOff,
        occupancy,
        rules,
        templateDefaults,
        ...(search.excludeBookingId !== undefined && { excludeBookingId: search.excludeBookingId }),
      }),
    ),
  });
}

/** A service as the engine books it. */
export function serviceToBook(service: ServiceRow): ServiceToBook {
  return {
    id: ServiceIdSchema.parse(service.id),
    active: service.active,
    durationMinutes: service.durationMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
  };
}
