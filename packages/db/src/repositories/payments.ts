import {
  PaymentAccountSnapshotSchema,
  PaymentAccountStatusSchema,
  PaymentProviderSchema,
  StripeAccountIdSchema,
  StripeEventIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type PaymentAccountSnapshot,
  type PaymentAccountStatus,
  type PaymentProvider,
  type StripeAccountId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { paymentAccounts, paymentWebhookEvents, type PaymentAccountRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Payments (S65, ADR-0067): the business's Stripe account and the webhook events Pepper handled.
// The account functions run in the business's transaction (RLS keeps them to its row); the event
// functions in the webhook's context (`withPaymentsWebhook`, `setTransactionPaymentsWebhook`).

const Id = z.uuid();

/** The business's payment account, if it has one; `lock`: held until the transaction ends. */
export async function findPaymentAccount(
  tx: TenantTx,
  options: { lock?: boolean } = {},
): Promise<PaymentAccountRow | undefined> {
  const query = tx.select().from(paymentAccounts).limit(1);
  const [row] = options.lock === true ? await query.for('update') : await query;
  return row;
}

function snapshotColumns(snapshot: PaymentAccountSnapshot) {
  const parsed = PaymentAccountSnapshotSchema.parse(snapshot);
  return {
    chargesEnabled: parsed.chargesEnabled,
    payoutsEnabled: parsed.payoutsEnabled,
    detailsSubmitted: parsed.detailsSubmitted,
    currentlyDue: parsed.currentlyDue,
    pastDue: parsed.pastDue,
    eventuallyDue: parsed.eventuallyDue,
    pendingVerification: parsed.pendingVerification,
    currentDeadline: parsed.currentDeadline === null ? null : new Date(parsed.currentDeadline),
    disabledReason: parsed.disabledReason,
  };
}

/** What a stored row says, in the contract's shape. */
export function paymentAccountSnapshotOf(row: PaymentAccountRow): PaymentAccountSnapshot {
  return PaymentAccountSnapshotSchema.parse({
    chargesEnabled: row.chargesEnabled,
    payoutsEnabled: row.payoutsEnabled,
    detailsSubmitted: row.detailsSubmitted,
    currentlyDue: row.currentlyDue,
    pastDue: row.pastDue,
    eventuallyDue: row.eventuallyDue,
    pendingVerification: row.pendingVerification,
    currentDeadline: row.currentDeadline?.toISOString() ?? null,
    disabledReason: row.disabledReason,
  });
}

export interface NewPaymentAccount {
  provider: PaymentProvider;
  providerAccountId: StripeAccountId;
  generation: number;
  livemode: boolean;
  status: PaymentAccountStatus;
  snapshot: PaymentAccountSnapshot;
  syncedAt: Date;
  createdBy: UserId;
}

function newAccountColumns(input: NewPaymentAccount) {
  return {
    provider: PaymentProviderSchema.parse(input.provider),
    providerAccountId: StripeAccountIdSchema.parse(input.providerAccountId),
    generation: z.number().int().min(1).max(1000).parse(input.generation),
    livemode: input.livemode,
    status: PaymentAccountStatusSchema.parse(input.status),
    ...snapshotColumns(input.snapshot),
    syncedAt: input.syncedAt,
    createdBy: UserIdSchema.parse(input.createdBy),
  };
}

/**
 * Stores the business's first account. `undefined` when it already has one (two requests at
 * once): the caller keeps the row that won.
 */
export async function insertPaymentAccount(
  tx: TenantTx,
  input: NewPaymentAccount,
): Promise<PaymentAccountRow | undefined> {
  const [row] = await tx
    .insert(paymentAccounts)
    .values(newAccountColumns(input))
    .onConflictDoNothing()
    .returning();
  return row;
}

/**
 * Puts a new account on a row that is no longer this deployment's (connecting again, ADR-0067
 * §4, §6.5): Stripe disconnected it, or it belongs to another provider or mode (the sandbox, or
 * test keys before going live). Only such a row of the expected generation changes, so two
 * reconnects at once make one.
 */
export async function replacePaymentAccount(
  tx: TenantTx,
  id: string,
  previousGeneration: number,
  input: NewPaymentAccount,
): Promise<PaymentAccountRow | undefined> {
  const [row] = await tx
    .update(paymentAccounts)
    .set({ ...newAccountColumns(input), deauthorizedAt: null })
    .where(
      and(
        eq(paymentAccounts.id, Id.parse(id)),
        eq(paymentAccounts.generation, previousGeneration),
        sql`(${paymentAccounts.deauthorizedAt} IS NOT NULL OR ${paymentAccounts.provider} <> ${PaymentProviderSchema.parse(input.provider)} OR ${paymentAccounts.livemode} <> ${input.livemode})`,
      ),
    )
    .returning();
  return row;
}

/**
 * Applies a read of the account made at `syncedAt` (AC-X-97): only to a connected row of that
 * Stripe account, and only when no newer read was applied, so reads finishing out of order
 * never move the status back. `undefined` when it didn't apply.
 */
export async function applyPaymentAccountSync(
  tx: TenantTx,
  input: {
    id: string;
    providerAccountId: StripeAccountId;
    snapshot: PaymentAccountSnapshot;
    status: PaymentAccountStatus;
    syncedAt: Date;
  },
): Promise<PaymentAccountRow | undefined> {
  const [row] = await tx
    .update(paymentAccounts)
    .set({
      ...snapshotColumns(input.snapshot),
      status: PaymentAccountStatusSchema.parse(input.status),
      syncedAt: input.syncedAt,
    })
    .where(
      and(
        eq(paymentAccounts.id, Id.parse(input.id)),
        eq(paymentAccounts.providerAccountId, StripeAccountIdSchema.parse(input.providerAccountId)),
        isNull(paymentAccounts.deauthorizedAt),
        or(isNull(paymentAccounts.syncedAt), lt(paymentAccounts.syncedAt, input.syncedAt)),
      ),
    )
    .returning();
  return row;
}

/** Stripe disconnected the account: its status is `not_connected` from now on. */
export async function markPaymentAccountDeauthorized(
  tx: TenantTx,
  input: { id: string; providerAccountId: StripeAccountId; at: Date },
): Promise<PaymentAccountRow | undefined> {
  const [row] = await tx
    .update(paymentAccounts)
    .set({ deauthorizedAt: input.at, status: 'not_connected' })
    .where(
      and(
        eq(paymentAccounts.id, Id.parse(input.id)),
        eq(paymentAccounts.providerAccountId, StripeAccountIdSchema.parse(input.providerAccountId)),
        isNull(paymentAccounts.deauthorizedAt),
      ),
    )
    .returning();
  return row;
}

/**
 * The business a Stripe account belongs to, through the definer `payment_account_tenant`
 * (ids only; a business being deleted is left out). The only route from a webhook to a business.
 */
export async function paymentAccountTenant(
  db: Database | TenantTx,
  provider: PaymentProvider,
  accountId: StripeAccountId,
): Promise<TenantId | null> {
  const result = await db.execute<{ tenant_id: string | null }>(
    sql`SELECT payment_account_tenant(${PaymentProviderSchema.parse(provider)}, ${StripeAccountIdSchema.parse(accountId)}) AS tenant_id`,
  );
  const tenantId = result.rows[0]?.tenant_id ?? null;
  return tenantId === null ? null : TenantIdSchema.parse(tenantId);
}

// ---- Webhook events (the webhook's context) ----

export const PaymentWebhookIgnoredReasonSchema = z.enum([
  'unknown_account',
  'other_mode',
  'unhandled_type',
  'no_account',
  // Stripe refused to show the account (it is no longer the platform's): nothing to apply.
  'unreadable_account',
]);
export type PaymentWebhookIgnoredReason = z.infer<typeof PaymentWebhookIgnoredReasonSchema>;

export interface PaymentWebhookEventClaim {
  id: string;
  /** `received`: to handle now (first delivery, or an earlier attempt failed). */
  outcome: 'received' | 'processed' | 'ignored';
  attempts: number;
}

/**
 * Records a delivery of an event once (AC-X-96): the first inserts it as `received`; a
 * redelivery of one still `received` counts an attempt and answers it to handle again; one
 * already handled answers its outcome, unchanged. The lock lasts only this short transaction:
 * two deliveries at once can both handle an event, which is harmless (a newer read wins, a
 * status change is applied, audited and pushed once, and finishing is conditional), so every
 * effect added to the handling must be just as idempotent.
 */
export async function claimPaymentWebhookEvent(
  tx: TenantTx,
  input: {
    provider: PaymentProvider;
    eventId: string;
    eventType: string;
    accountId: StripeAccountId | null;
    livemode: boolean;
    createdAtProvider: Date;
    receivedAt: Date;
  },
): Promise<PaymentWebhookEventClaim> {
  const provider = PaymentProviderSchema.parse(input.provider);
  const eventId = StripeEventIdSchema.parse(input.eventId);
  const [inserted] = await tx
    .insert(paymentWebhookEvents)
    .values({
      provider,
      eventId,
      eventType: z
        .string()
        .regex(/^[a-z0-9_.]{1,100}$/)
        .parse(input.eventType),
      accountId: input.accountId === null ? null : StripeAccountIdSchema.parse(input.accountId),
      livemode: input.livemode,
      createdAtProvider: input.createdAtProvider,
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: paymentWebhookEvents.id, attempts: paymentWebhookEvents.attempts });
  if (inserted !== undefined) return { id: inserted.id, outcome: 'received', attempts: 1 };
  const [existing] = await tx
    .select({
      id: paymentWebhookEvents.id,
      outcome: paymentWebhookEvents.outcome,
      attempts: paymentWebhookEvents.attempts,
    })
    .from(paymentWebhookEvents)
    .where(
      and(eq(paymentWebhookEvents.provider, provider), eq(paymentWebhookEvents.eventId, eventId)),
    )
    .for('update');
  if (existing === undefined) throw new Error('payment webhook event vanished while claimed');
  const outcome = z.enum(['received', 'processed', 'ignored']).parse(existing.outcome);
  if (outcome !== 'received') return { id: existing.id, outcome, attempts: existing.attempts };
  const attempts = Math.min(existing.attempts + 1, 1000);
  await tx
    .update(paymentWebhookEvents)
    .set({ attempts })
    .where(eq(paymentWebhookEvents.id, existing.id));
  return { id: existing.id, outcome, attempts };
}

/** Marks a claimed event handled: `processed` (with its business) or `ignored` (with why). */
export async function finishPaymentWebhookEvent(
  tx: TenantTx,
  id: string,
  input:
    | { outcome: 'processed'; tenantId: TenantId; at: Date }
    | {
        outcome: 'ignored';
        reason: PaymentWebhookIgnoredReason;
        tenantId: TenantId | null;
        at: Date;
      },
): Promise<void> {
  await tx
    .update(paymentWebhookEvents)
    .set({
      outcome: input.outcome,
      ignoredReason:
        input.outcome === 'ignored' ? PaymentWebhookIgnoredReasonSchema.parse(input.reason) : null,
      tenantId: input.tenantId === null ? null : TenantIdSchema.parse(input.tenantId),
      processedAt: input.at,
    })
    .where(
      and(eq(paymentWebhookEvents.id, Id.parse(id)), eq(paymentWebhookEvents.outcome, 'received')),
    );
}

/** One event as handled (tests and the operator's view). */
export async function findPaymentWebhookEvent(
  tx: TenantTx,
  provider: PaymentProvider,
  eventId: string,
): Promise<typeof paymentWebhookEvents.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(paymentWebhookEvents)
    .where(
      and(
        eq(paymentWebhookEvents.provider, PaymentProviderSchema.parse(provider)),
        eq(paymentWebhookEvents.eventId, StripeEventIdSchema.parse(eventId)),
      ),
    );
  return row;
}

/** Deletes up to `limit` events received before `before` (the daily clean-up, 30 days). */
export async function deleteOldPaymentWebhookEvents(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const result = await tx.execute(
    sql`DELETE FROM payment_webhook_events WHERE id IN (
      SELECT id FROM payment_webhook_events WHERE received_at < ${before} ORDER BY received_at LIMIT ${limit}
    )`,
  );
  return result.rowCount ?? 0;
}
