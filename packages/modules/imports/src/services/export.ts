import {
  auditActorOf,
  readScreenshotsForExport,
  requirePermission,
  systemClock,
  type Actor,
  type Clock,
  type ScreenshotStorage,
} from '@pepper/core';
import { appendAuditEntry, readBusinessExport, withMember, type Database } from '@pepper/db';
import { buildBusinessExport, type BusinessExport } from '../export.js';

// Business export (S51, ADR-0053, AC-W1-37): the owner downloads everything the business holds
// in Pepper. Read in one transaction and audited with counts only; the bytes go straight to
// the owner and no copy is kept.

/**
 * The business's export as a ZIP; the owner only (`business.export`). With `store`, the
 * support screenshots' images go in it too (S59.2.3, AC-X-31).
 */
export async function exportBusiness(
  db: Database,
  actor: Actor,
  clock: Clock = systemClock,
  store: ScreenshotStorage | null = null,
): Promise<BusinessExport> {
  requirePermission(actor, 'business.export');
  // Read in one transaction; the screenshots' images are fetched after it closes (S59.2.3), so
  // storage round-trips never hold a database connection.
  const data = await withMember(db, actor.context, readBusinessExport);
  const images = await readScreenshotsForExport(
    actor.context.tenantId,
    data.support.screenshots,
    store,
  );
  const built = buildBusinessExport(data, clock.now(), images);
  return withMember(db, actor.context, async (tx) => {
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
