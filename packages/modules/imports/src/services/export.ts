import { requirePermission, auditActorOf, systemClock, type Actor, type Clock } from '@pepper/core';
import { appendAuditEntry, readBusinessExport, withMember, type Database } from '@pepper/db';
import { buildBusinessExport, type BusinessExport } from '../export.js';

// Business export (S51, ADR-0053, AC-W1-37): the owner downloads everything the business holds
// in Pepper. Read in one transaction and audited with counts only; the bytes go straight to
// the owner and no copy is kept.

/** The business's export as a ZIP; the owner only (`business.export`). */
export async function exportBusiness(
  db: Database,
  actor: Actor,
  clock: Clock = systemClock,
): Promise<BusinessExport> {
  requirePermission(actor, 'business.export');
  return withMember(db, actor.context, async (tx) => {
    const built = buildBusinessExport(await readBusinessExport(tx), clock.now());
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'business.exported',
        entity: { type: 'tenant', id: actor.context.tenantId },
        before: null,
        after: built.counts,
      },
      requestId: actor.requestId,
    });
    return built;
  });
}
