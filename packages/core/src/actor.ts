import type { AuditActor, Permission } from '@pepper/contracts';
import { ForbiddenError } from './errors.js';
import { can, type OwnedRecord } from './permissions.js';
import type { TenantContext } from './tenant-access.js';

/**
 * Who calls a domain service: the tenant context resolved from the session (never from
 * request bodies or LLM arguments) and, for the audit log, the request id.
 */
export interface Actor {
  context: TenantContext;
  requestId?: string | undefined;
  /**
   * Set when the AI employee calls the service for the member (an AI tool, ADR-0028): the
   * same permissions apply, and the audit log records the AI acting on their behalf.
   */
  via?: 'ai' | undefined;
}

/** Who the audit log names for a change the actor makes. */
export function auditActorOf(actor: Actor): AuditActor {
  return actor.via === 'ai'
    ? { kind: 'ai_on_behalf_of', userId: actor.context.userId }
    : { kind: 'user', userId: actor.context.userId };
}

/** Throws `ForbiddenError` unless the actor may use `permission` (on `record`, if given). */
export function requirePermission(
  actor: Actor,
  permission: Permission,
  record?: OwnedRecord,
): void {
  if (!can(actor.context, permission, record)) throw new ForbiddenError(permission);
}
