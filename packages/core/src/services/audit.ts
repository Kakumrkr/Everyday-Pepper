import { AuditLogQuerySchema, type AuditLogQuery, type AuditLogResponse } from '@floty/contracts';
import { listAuditEntries, withTenant, type Database } from '@floty/db';
import { requirePermission, type Actor } from '../actor.js';

/** A page of the actor's business's audit log, newest first. Needs `audit.read`. */
export async function readAuditLog(
  db: Database,
  actor: Actor,
  query: AuditLogQuery = {},
): Promise<AuditLogResponse> {
  requirePermission(actor, 'audit.read');
  const { limit, before } = AuditLogQuerySchema.parse(query);
  // One extra row tells whether another page follows.
  const rows = await withTenant(db, actor.context.tenantId, (tx) =>
    listAuditEntries(tx, { limit: limit + 1, before }),
  );
  const entries = rows.slice(0, limit);
  const last = entries.at(-1);
  return { entries, nextBefore: rows.length > limit && last !== undefined ? last.id : null };
}
