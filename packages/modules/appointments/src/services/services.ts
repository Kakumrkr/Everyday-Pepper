import {
  depositRuleProblem,
  ServiceIdSchema,
  ServiceInputSchema,
  type Service,
  type ServiceId,
  type ServiceInput,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  depositRuleOf,
  insertService,
  listServices as listServiceRows,
  lockService,
  updateService as updateServiceRow,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { DepositRuleMismatchError, ServiceNotFoundError } from '../errors.js';
import { sameValues, serviceAuditValues, toService } from '../mapping.js';
import { noteBookableIn } from './activation.js';

// The business's services menu (ADR-0015). Changes need `services.manage` and are audited in
// the same transaction. Services are deactivated, not deleted: bookings will refer to them.

/** The business's services, by name. Needs `services.read`. */
export async function listServices(db: Database, actor: Actor): Promise<Service[]> {
  requirePermission(actor, 'services.read');
  const rows = await withTenant(db, actor.context.tenantId, listServiceRows);
  return rows.map(toService);
}

/** `listServices` inside the caller's transaction. */
export async function listServicesIn(tx: TenantTx, actor: Actor): Promise<Service[]> {
  requirePermission(actor, 'services.read');
  return (await listServiceRows(tx)).map(toService);
}

/** Adds a service. Throws `ServiceNameTakenError` (`@pepper/db`) for a name already in use. */
export async function createService(
  db: Database,
  actor: Actor,
  input: ServiceInput,
): Promise<Service> {
  requirePermission(actor, 'services.manage');
  return withTenant(db, actor.context.tenantId, (tx) => createServiceIn(tx, actor, input));
}

/**
 * `createService` inside the caller's transaction. `rebookAfterDays`: when a regular is due
 * again, from a template's starting menu (S45).
 */
export async function createServiceIn(
  tx: TenantTx,
  actor: Actor,
  input: ServiceInput,
  options: { rebookAfterDays?: number | null } = {},
): Promise<Service> {
  requirePermission(actor, 'services.manage');
  const fields = ServiceInputSchema.parse(input);
  const row = await insertService(tx, fields, options);
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'service.created',
      entity: { type: 'service', id: row.id },
      before: null,
      after: serviceAuditValues(row),
    },
    requestId: actor.requestId,
  });
  return toService(row);
}

/** Replaces a service's fields (all of them; `active: false` takes it off the menu). */
export async function updateService(
  db: Database,
  actor: Actor,
  serviceId: ServiceId,
  input: ServiceInput,
): Promise<Service> {
  requirePermission(actor, 'services.manage');
  const id = ServiceIdSchema.parse(serviceId);
  const fields = ServiceInputSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const current = await lockService(tx, id);
    if (current === undefined) throw new ServiceNotFoundError();
    // A rule left out stays (S66): it must still fit the new price.
    const problem =
      fields.deposit === undefined
        ? depositRuleProblem(depositRuleOf(current), fields.priceFromCents)
        : null;
    if (problem !== null) throw new DepositRuleMismatchError(problem.message);
    const row = await updateServiceRow(tx, id, fields);
    if (row === undefined) throw new ServiceNotFoundError();
    const [before, after] = [serviceAuditValues(current), serviceAuditValues(row)];
    if (!sameValues(before, after)) {
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: { action: 'service.updated', entity: { type: 'service', id }, before, after },
        requestId: actor.requestId,
      });
      // A service back on the menu can make the business bookable.
      await noteBookableIn(tx);
    }
    return toService(row);
  });
}
