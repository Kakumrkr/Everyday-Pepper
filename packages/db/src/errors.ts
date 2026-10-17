/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';
/** Postgres SQLSTATE for an exclusion constraint violation. */
const EXCLUSION_VIOLATION = '23P01';

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
}

/**
 * Whether `error` (or an error it wraps; drizzle wraps driver errors as `cause`) is a unique
 * violation of `constraint`.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, UNIQUE_VIOLATION, constraint);
}

/** Whether `error` (or an error it wraps) is an exclusion violation of `constraint`. */
export function isExclusionViolation(error: unknown, constraint: string): boolean {
  return isViolation(error, EXCLUSION_VIOLATION, constraint);
}

function isViolation(error: unknown, code: string, constraint: string): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    const fields = current as Error & PgErrorFields;
    if (fields.code === code && fields.constraint === constraint) return true;
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

/** The user already owns as many businesses as one person may create. */
export class BusinessLimitReachedError extends Error {
  constructor(readonly limit: number) {
    super(`A user may own at most ${String(limit)} businesses`);
    this.name = 'BusinessLimitReachedError';
  }
}

/** The business already has a service with this name (names are compared case-insensitively). */
export class ServiceNameTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super('The business already has a service with this name', options);
    this.name = 'ServiceNameTakenError';
  }
}

/** The member's login is already linked to another staff member. */
export class StaffMemberLinkTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super("This member's login is already linked to another staff member", options);
    this.name = 'StaffMemberLinkTakenError';
  }
}

/** The business already has a client with this email. */
export class ClientEmailTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super('The business already has a client with this email', options);
    this.name = 'ClientEmailTakenError';
  }
}

/**
 * The booking would overlap another active booking of the staff member, buffers included
 * (the `booking_occupancy_no_overlap` exclusion constraint).
 */
export class BookingOverlapError extends Error {
  constructor(options?: ErrorOptions) {
    super('The staff member already has a booking at this time', options);
    this.name = 'BookingOverlapError';
  }
}

/** Another booking of the business already has this idempotency key. */
export class BookingIdempotencyKeyTakenError extends Error {
  constructor(options?: ErrorOptions) {
    super('Another booking already has this idempotency key', options);
    this.name = 'BookingIdempotencyKeyTakenError';
  }
}
