import * as Sentry from '@sentry/node';

/**
 * Raises an alert for a problem a person must look at that is not an exception (e.g. an outbox
 * message given up, ADR-0024): an error-level Sentry event with `tags`, which must be ids or
 * codes, never personal data. A no-op without a Sentry DSN; callers log it as well.
 */
export function raiseAlert(message: string, tags: Record<string, string>): void {
  Sentry.captureMessage(message, { level: 'error', tags });
}
