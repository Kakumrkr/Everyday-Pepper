import { z } from 'zod';

// The transactional outbox (ADR-0003, ADR-0024). A side effect (today: an email) is written
// as a message in the same transaction as the business change, and the worker delivers it
// later, retrying with backoff. Each message is sent at most once after the mail server
// accepted it; a dedupe key per business keeps a retried change from queueing it twice.

/** An outbox message: a lowercased UUID. */
export const OutboxMessageIdSchema = z.uuid().toLowerCase().brand<'OutboxMessageId'>();
export type OutboxMessageId = z.infer<typeof OutboxMessageIdSchema>;

/** What a message does when delivered. Only email for now; SMS and push come later. */
export const OutboxMessageTypeSchema = z.enum(['email']);
export type OutboxMessageType = z.infer<typeof OutboxMessageTypeSchema>;

/**
 * Where a message stands: waiting (also between retries), delivered, or given up after the
 * last attempt (`dead`, kept for the alert and a person to look at).
 */
export const OutboxStatusSchema = z.enum(['pending', 'sent', 'dead']);
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/**
 * Names one side effect within a business, e.g. `booking.confirmed:<booking id>`: queueing a
 * second message with the same key does nothing. Letters, digits and `.:_-` only, so it
 * never carries personal data.
 */
export const OutboxDedupeKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9.:_-]{1,200}$/, 'Use letters, digits and .:_- only');
export type OutboxDedupeKey = z.infer<typeof OutboxDedupeKeySchema>;

/** One plain-text email, as queued. Its content is stored encrypted and cleared once sent. */
export const OutboxEmailSchema = z.object({
  to: z.email().max(254),
  // One line: a line break in a name must not start another header.
  subject: z
    .string()
    .max(300)
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1)),
  text: z.string().min(1).max(50_000),
});
export type OutboxEmail = z.infer<typeof OutboxEmailSchema>;
export type OutboxEmailInput = z.input<typeof OutboxEmailSchema>;

/** Delivery attempts before a message is `dead`. */
export const OUTBOX_MAX_ATTEMPTS = 8;

/**
 * Wait before attempt `attempt + 1` after `attempt` failed (1-based): 30 s doubling to at
 * most 1 hour, so the 8 attempts span about 2 hours.
 */
export function outboxRetryDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt));
  return Math.min(30_000 * 2 ** (step - 1), 3_600_000);
}
