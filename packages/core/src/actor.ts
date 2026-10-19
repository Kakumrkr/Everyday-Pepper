import type { Permission } from '@pepper/contracts';
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
}

/** Throws `ForbiddenError` unless the actor may use `permission` (on `record`, if given). */
export function requirePermission(
  actor: Actor,
  permission: Permission,
  record?: OwnedRecord,
): void {
  if (!can(actor.context, permission, record)) throw new ForbiddenError(permission);
}
