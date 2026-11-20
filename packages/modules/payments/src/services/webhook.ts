import {
  isHandledStripeEvent,
  PaymentAccountStatusSchema,
  type StripeEvent,
  type TenantId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  claimPaymentWebhookEvent,
  findPaymentAccount,
  finishPaymentWebhookEvent,
  markPaymentAccountDeauthorized,
  paymentAccountTenant,
  setTransactionPaymentsWebhook,
  withPaymentsWebhook,
  withTenant,
  type PaymentWebhookIgnoredReason,
} from '@pepper/db';
import { PaymentsProviderError } from '../provider.js';
import { syncPaymentAccount, type PaymentsDeps } from './accounts.js';

// Stripe's webhook events, once each (S65, ADR-0067 §6, AC-X-99…101). The caller has checked
// the signature and parsed the envelope. An event counts once (its id); the business is found
// only through the stored Stripe account id; what changed is read from Stripe again, never
// taken from the event; the event is marked handled in the same transaction as the change.

export type WebhookOutcome =
  | { outcome: 'processed'; tenantId: TenantId }
  | { outcome: 'ignored'; reason: PaymentWebhookIgnoredReason }
  /** Already handled: a redelivery or a replay, nothing changed. */
  | { outcome: 'duplicate' };

export async function handleStripeEvent(
  deps: PaymentsDeps,
  event: StripeEvent,
): Promise<WebhookOutcome> {
  const now = deps.clock.now();
  const claim = await withPaymentsWebhook(deps.db, (tx) =>
    claimPaymentWebhookEvent(tx, {
      provider: deps.provider.provider,
      eventId: event.id,
      eventType: event.type,
      accountId: event.account ?? null,
      livemode: event.livemode,
      createdAtProvider: new Date(event.created * 1000),
      receivedAt: now,
    }),
  );
  if (claim.outcome !== 'received') return { outcome: 'duplicate' };

  const ignore = async (
    reason: PaymentWebhookIgnoredReason,
    tenantId: TenantId | null = null,
  ): Promise<WebhookOutcome> => {
    await withPaymentsWebhook(deps.db, (tx) =>
      finishPaymentWebhookEvent(tx, claim.id, { outcome: 'ignored', reason, tenantId, at: now }),
    );
    return { outcome: 'ignored', reason };
  };

  // A test event at a live endpoint (or the reverse) is a misconfiguration: change nothing.
  if (event.livemode !== deps.provider.livemode) return ignore('other_mode');
  if (!isHandledStripeEvent(event.type)) return ignore('unhandled_type');
  const accountId = event.account;
  if (accountId === undefined || accountId === null) return ignore('no_account');
  const tenantId = await paymentAccountTenant(deps.db, deps.provider.provider, accountId);
  if (tenantId === null) return ignore('unknown_account');

  const finish = async (tx: Parameters<typeof setTransactionPaymentsWebhook>[0]) => {
    await setTransactionPaymentsWebhook(tx);
    await finishPaymentWebhookEvent(tx, claim.id, { outcome: 'processed', tenantId, at: now });
  };

  if (event.type === 'account.application.deauthorized') {
    // Signed by Stripe, and the account can no longer be read: take the event's word.
    await withTenant(deps.db, tenantId, async (tx) => {
      const row = await findPaymentAccount(tx, { lock: true });
      if (row?.providerAccountId === accountId) {
        const marked = await markPaymentAccountDeauthorized(tx, {
          id: row.id,
          providerAccountId: accountId,
          at: now,
        });
        if (marked !== undefined && row.status !== 'not_connected') {
          await appendAuditEntry(tx, {
            actor: { kind: 'system' },
            change: {
              action: 'payments.account_status_changed',
              entity: { type: 'payment_account', id: row.id },
              before: { status: PaymentAccountStatusSchema.parse(row.status) },
              after: { status: 'not_connected' },
            },
          });
        }
      }
      await finish(tx);
    });
    return { outcome: 'processed', tenantId };
  }

  try {
    await syncPaymentAccount(deps, tenantId, { accountId, actor: { kind: 'system' }, finish });
  } catch (error) {
    // Stripe won't show the account (no longer the platform's): nothing to apply, ever.
    if (error instanceof PaymentsProviderError && !error.retryable) {
      return ignore('unreadable_account', tenantId);
    }
    // Anything else leaves the event `received`: the webhook answers 500, Stripe delivers again.
    throw error;
  }
  return { outcome: 'processed', tenantId };
}
