import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';

// Deleting a business or an account (S51.2, ADR-0054): asked for now, done for good after a
// grace period in which it can be kept.

/** How long a business or an account waits before it is deleted for good. */
export const DELETION_GRACE_DAYS = 30;

/** Whether a business or an account is being deleted, and the day it will be (UTC). */
export const DeletionStatusSchema = z
  .object({
    /** `null`: not being deleted. */
    dueAt: UtcDateTimeSchema.nullable(),
  })
  .strict();
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>;

/** `POST /v1/tenant/deletion`: the owner types the business's name to confirm. */
export const BusinessDeletionRequestSchema = z
  .object({ confirmName: z.string().trim().min(1).max(200) })
  .strict();
export type BusinessDeletionRequest = z.infer<typeof BusinessDeletionRequestSchema>;

/** `POST /v1/me/deletion`: the account's password confirms it. */
export const AccountDeletionRequestSchema = z
  .object({ password: z.string().min(1).max(128) })
  .strict();
export type AccountDeletionRequest = z.infer<typeof AccountDeletionRequestSchema>;

/**
 * Whether `typed` names the business `name`: the same words, ignoring case, spacing and curly
 * quotes, so "juniper hair  studio" confirms "Juniper Hair Studio".
 */
export function confirmsBusinessName(typed: string, name: string): boolean {
  const plain = (value: string) =>
    value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  return plain(typed) !== '' && plain(typed) === plain(name);
}
