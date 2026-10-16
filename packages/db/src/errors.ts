/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Whether `error` (or an error it wraps; drizzle wraps driver errors as `cause`) is a unique
 * violation of `constraint`.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const fields = current as Error & PgErrorFields;
    if (fields.code === UNIQUE_VIOLATION && fields.constraint === constraint) return true;
    current = current.cause;
  }
  return false;
}

/** Another business already uses this booking-page slug. */
export class TenantSlugTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super('This slug is already taken', options);
    this.name = 'TenantSlugTakenError';
  }
}

/** The user is already a member of the tenant. */
export class MembershipExistsError extends Error {
  constructor(options?: ErrorOptions) {
    super('The user is already a member of this business', options);
    this.name = 'MembershipExistsError';
  }
}
