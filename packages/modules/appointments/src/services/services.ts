import {
  ServiceIdSchema,
  ServiceInputSchema,
  type Service,
  type ServiceId,
  type ServiceInput,
} from '@pepper/contracts';
import { requirePermission, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  insertService,
  listServices as listServiceRows,
  lockService,
  updateService as updateServiceRow,
  withTenant,
  type Database,
} from '@pepper/db';
import { ServiceNotFoundError } from '../errors.js';
import { sameValues, serviceAuditValues, toService } from '../mapping.js';

// The business's services menu (ADR-0015). Changes need `services.manage` and are audited in
// the same transaction. Services are deactivated, not deleted: bookings will refer to them.

/** The business's services, by name. Needs `services.read`. */
export async function listServices(db: Database, actor: Actor): Promise<Service[]> {
  requirePermission(actor, 'services.read');
  const rows = await withTenant(db, actor.context.tenantId, listServiceRows);
  return rows.map(toService);
}

/** Adds a service. Throws `ServiceNameTakenError` (`@pepper/db`) for a name already in use. */
export async function createService(
  db: Database,
  actor: Actor,
  input: ServiceInput,
): Promise<Service> {
  requirePermission(actor, 'services.manage');
  const fields = ServiceInputSchema.parse(input);
  return withTenant(db, actor.context.tenantId, async (tx) => {
    const row = await insertService(tx, fields);
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: actor.context.userId },
      change: {
        action: 'service.created',
        entity: { type: 'service', id: row.id },
        before: null,
        after: serviceAuditValues(row),
      },
      requestId: actor.requestId,
    });
    return toService(row);
  });
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
    const row = await updateServiceRow(tx, id, fields);
    if (row === undefined) throw new ServiceNotFoundError();
    const [before, after] = [serviceAuditValues(current), serviceAuditValues(row)];
    if (!sameValues(before, after)) {
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: { action: 'service.updated', entity: { type: 'service', id }, before, after },
        requestId: actor.requestId,
      });
    }
    return toService(row);
  });
}
