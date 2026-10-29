import {
  SetupReviewSchema,
  type Service,
  type SetupReview,
  type SetupWarning,
  type StaffMember,
  type StaffMemberId,
  type WeeklyHours,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  findCurrentTenant,
  markCurrentTenantSetupReviewed,
  withTenant,
  type Database,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import { listWeeklyHoursIn } from './hours.js';
import { listServicesIn } from './services.js';
import { listStaffIn } from './staff.js';

// Home's setup review (S46, PCR-009, AC-W1-11/12). Owners and managers (`settings.manage`)
// see what the business is set up with and what currently stops clients from booking. The
// warnings come from today's services, staff and hours every time: never from the one-time
// `bookable` event, and "I've checked these" does not turn them off. Time off and full days
// are availability, not setup, so they are not read here.

/** The setup review of the actor's business. */
export async function getSetupReview(db: Database, actor: Actor): Promise<SetupReview> {
  requirePermission(actor, 'settings.manage');
  return withTenant(db, actor.context.tenantId, (tx) => setupReviewIn(tx, actor));
}

/**
 * Records that the setup was checked (the first time stays; audited once) and returns the
 * review. Changes no service, staff member or hours, and creates no activation event.
 */
export async function acknowledgeSetupReview(
  db: Database,
  actor: Actor,
  now: Date = new Date(),
): Promise<SetupReview> {
  requirePermission(actor, 'settings.manage');
  return withTenant(db, actor.context.tenantId, async (tx) => {
    // Written only the first time, so only the first (of any concurrent ones) is audited.
    const marked = await markCurrentTenantSetupReviewed(tx, now);
    if (marked !== undefined) {
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'tenant.updated',
          entity: { type: 'tenant', id: marked.id },
          before: { setupReviewed: false },
          after: { setupReviewed: true },
        },
        requestId: actor.requestId,
      });
    }
    return setupReviewIn(tx, actor, marked);
  });
}

async function setupReviewIn(tx: TenantTx, actor: Actor, known?: Tenant): Promise<SetupReview> {
  // A member's own business is always visible to them.
  const tenant = known ?? (await findCurrentTenant(tx));
  if (tenant === undefined) throw new Error('No tenant in this transaction');
  const services = (await listServicesIn(tx, actor)).filter((service) => service.active);
  const staff = (await listStaffIn(tx, actor)).filter((member) => member.active);
  const hours = await listWeeklyHoursIn(
    tx,
    actor,
    staff.map((member) => member.id),
  );
  const activeIds = new Set(services.map((service) => service.id));
  const prices = services.flatMap((service) =>
    service.priceFromCents === null
      ? []
      : [service.priceFromCents, service.priceToCents ?? service.priceFromCents],
  );
  return SetupReviewSchema.parse({
    reviewedAt: tenant.setupReviewedAt?.toISOString() ?? null,
    timeZone: tenant.timeZone,
    services: {
      count: services.length,
      lowestPriceCents: prices.length === 0 ? null : Math.min(...prices),
      highestPriceCents: prices.length === 0 ? null : Math.max(...prices),
    },
    providers: staff.map((member) => ({
      id: member.id,
      displayName: member.displayName,
      isYou: member.userId !== null && member.userId === actor.context.userId,
      serviceCount: member.serviceIds.filter((id) => activeIds.has(id)).length,
      hours: hours.get(member.id) ?? { intervals: [] },
    })),
    warnings: setupWarnings(services, staff, hours),
  });
}

/**
 * What currently stops clients from booking, from active services and staff and their hours:
 * no service at all; a staff member who offers services but has no hours; a service no one
 * with hours offers. Inactive services and staff are ignored.
 */
export function setupWarnings(
  services: readonly Pick<Service, 'id' | 'name' | 'active'>[],
  staff: readonly Pick<StaffMember, 'id' | 'displayName' | 'active' | 'serviceIds'>[],
  hours: ReadonlyMap<StaffMemberId, WeeklyHours>,
): SetupWarning[] {
  const active = services.filter((service) => service.active);
  if (active.length === 0) return [{ kind: 'no_services' }];
  const activeIds = new Set(active.map((service) => service.id));
  const working = staff.filter((member) => member.active);
  const hasHours = (id: StaffMemberId): boolean => (hours.get(id)?.intervals.length ?? 0) > 0;
  const warnings: SetupWarning[] = working
    .filter((member) => member.serviceIds.some((id) => activeIds.has(id)) && !hasHours(member.id))
    .map((member) => ({
      kind: 'staff_without_hours',
      staffMemberId: member.id,
      displayName: member.displayName,
    }));
  const offered = new Set(
    working.filter((member) => hasHours(member.id)).flatMap((member) => member.serviceIds),
  );
  for (const service of active) {
    if (!offered.has(service.id)) {
      warnings.push({
        kind: 'service_without_provider',
        serviceId: service.id,
        name: service.name,
      });
    }
  }
  return warnings;
}
