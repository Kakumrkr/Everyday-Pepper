import { z } from 'zod';
import { ClientIdSchema } from './clients.js';
import { UtcDateTimeSchema } from './time.js';
import { ActionProposalIdSchema } from './trust.js';

// "Haven't been back" (S54.2, ADR-0057; AC-W4-6…9): the clients with at least 2 visits who
// are past their usual gap with nothing booked, what each is worth, and a one-tap drafted
// email (the rebooking nudge of ADR-0040, its words written by the domain). Owners and
// managers only: they decide the nudges.

export const WIN_BACK_LIMITS = {
  /** Win-back drafts one business may make in one local day (with the morning pass's own). */
  perBusinessPerDay: 20,
  /** No second marketing email to a client within this many days of a nudge. */
  quietDays: 28,
  /** How far ahead the draft looks for the client's next open time. */
  searchDays: 7,
  /** Rows the list returns (the count and the sum cover every client). */
  listMax: 200,
} as const;

/** Whether the client can be emailed: the reason shows on the row when not. */
export const WinBackReachSchema = z.enum(['email', 'no_email', 'opted_out']);
export type WinBackReach = z.infer<typeof WinBackReachSchema>;

export const WinBackClientSchema = z.object({
  clientId: ClientIdSchema,
  name: z.string(),
  lastVisitAt: UtcDateTimeSchema,
  /** The last visit's service and who did it; `null` once deleted. */
  serviceName: z.string().nullable(),
  staffName: z.string().nullable(),
  /** The last service's price (cents), `null` when it has none. */
  valueCents: z.number().int().nonnegative().nullable(),
  visits: z.number().int().positive(),
  daysOverdue: z.number().int().nonnegative(),
  reach: WinBackReachSchema,
  /** A drafted email waiting for an OK (the win-back's or the morning pass's). */
  pendingProposalId: ActionProposalIdSchema.nullable(),
  /** The last nudge or offer within the quiet window: no new draft until it passes. */
  emailedAt: UtcDateTimeSchema.nullable(),
});
export type WinBackClient = z.infer<typeof WinBackClientSchema>;

export const WinBackResponseSchema = z.object({
  clients: z.array(WinBackClientSchema).max(WIN_BACK_LIMITS.listMax),
  /** Every client who hasn't been back, and the sum of the priced ones (AC-W4-8's numbers). */
  count: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  /** Without the business's mailing address no marketing email can go (CAN-SPAM). */
  mailingAddressSet: z.boolean(),
});
export type WinBackResponse = z.infer<typeof WinBackResponseSchema>;

export const WinBackRefusalSchema = z.enum([
  /** Not (or no longer) on the list: booked meanwhile, too few visits. */
  'not_due',
  'no_email',
  'opted_out',
  'no_address',
  'recently_emailed',
  'daily_limit',
  /** No open time for their service in the next `searchDays`. */
  'no_time',
]);
export type WinBackRefusal = z.infer<typeof WinBackRefusalSchema>;

export const WinBackDraftResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drafted'), proposalId: ActionProposalIdSchema }),
  z.object({ kind: z.literal('refused'), reason: WinBackRefusalSchema }),
]);
export type WinBackDraftResult = z.infer<typeof WinBackDraftResultSchema>;
