import {
  AuditActorSchema,
  AuditChangeSchema,
  AuditLogEntrySchema,
  type AuditActor,
  type AuditChange,
  type AuditLogEntry,
} from '@pepper/contracts';
import { desc, lt } from 'drizzle-orm';
import { z } from 'zod';
import { auditLog } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The audit log is append-only (ADR-0013): these are the only two operations, and the services'
// role has no UPDATE or DELETE grant on the table. Run inside `withTenant`, in the same
// transaction as the change being recorded, so the entry and the change commit or roll back
// together.

export interface AuditEntryInput {
  actor: AuditActor;
  change: AuditChange;
  /** The request's `x-request-id`, if the change came from one. */
  requestId?: string | undefined;
}

const RequestIdSchema = z.string().min(1).max(128);

/** Records a change. Rejects anything outside its action's schema (no personal data). */
export async function appendAuditEntry(tx: TenantTx, input: AuditEntryInput): Promise<void> {
  const actor = AuditActorSchema.parse(input.actor);
  const change = AuditChangeSchema.parse(input.change);
  await tx.insert(auditLog).values({
    actorKind: actor.kind,
    actorUserId: actor.kind === 'user' ? actor.userId : null,
    action: change.action,
    entityType: change.entity.type,
    entityId: change.entity.id,
    before: change.before,
    after: change.after,
    requestId: input.requestId === undefined ? null : RequestIdSchema.parse(input.requestId),
  });
}

/** The transaction tenant's entries, newest first: `limit` of them older than `before`. */
export async function listAuditEntries(
  tx: TenantTx,
  query: { limit: number; before?: string | undefined },
): Promise<AuditLogEntry[]> {
  const limit = z.number().int().min(1).max(1000).parse(query.limit);
  const before = query.before === undefined ? undefined : z.uuid().parse(query.before);
  const rows = await tx
    .select()
    .from(auditLog)
    .where(before === undefined ? undefined : lt(auditLog.id, before))
    .orderBy(desc(auditLog.id))
    .limit(limit);
  return rows.map((row) =>
    AuditLogEntrySchema.parse({
      id: row.id,
      at: row.createdAt.toISOString(),
      actor: { kind: row.actorKind, userId: row.actorUserId },
      action: row.action,
      entity: { type: row.entityType, id: row.entityId },
      before: row.before,
      after: row.after,
    }),
  );
}
