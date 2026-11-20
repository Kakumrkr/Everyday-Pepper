import {
  OutboxDedupeKeySchema,
  paymentAccountStatus,
  PaymentAccountAnswerSchema,
  PaymentAccountStatusSchema,
  PaymentDashboardLinkSchema,
  PaymentOnboardingLinkSchema,
  snapshotOfStripeAccount,
  UserIdSchema,
  type AuditActor,
  type PaymentAccountAnswer,
  type PaymentAccountStatus,
  type PaymentDashboardLink,
  type PaymentOnboardingLink,
  type StripeAccountId,
  type TenantId,
} from '@pepper/contracts';
import { can, queuePushToMembers, requirePermission, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  applyPaymentAccountSync,
  findCurrentTenant,
  findPaymentAccount,
  insertPaymentAccount,
  listMemberships,
  paymentAccountSnapshotOf,
  replacePaymentAccount,
  withMember,
  withTenant,
  type Database,
  type NewPaymentAccount,
  type PaymentAccountRow,
  type TenantTx,
} from '@pepper/db';
import { PaymentsNotOnboardedError, PaymentsRejectedError } from '../errors.js';
import { paymentsNotice, PAYMENTS_PAGE } from '../notices.js';
import { PaymentsProviderError, type PaymentsProvider } from '../provider.js';

// The business's Stripe account (S65, ADR-0067 §4–5, §7): connect it (the owner), read where it
// stands (owners and managers), read it again from Stripe and apply what changed. No call to
// Stripe runs inside a database transaction; the business comes from the session (the owner's
// calls) or from the stored account id (the webhook), never from a request body or an event.

export interface PaymentsDeps {
  db: Database;
  provider: PaymentsProvider;
  clock: Clock;
  /** Seals the owner's push in the outbox (ADR-0024). */
  outboxKey: Buffer;
  /** Pepper's public origin: Stripe's return and refresh pages are there. */
  baseUrl: string;
}

/** Stripe's idempotency key for the business's account of `generation` (ADR-0067 §4). */
export function accountIdempotencyKey(tenantId: TenantId, generation: number): string {
  return `pepper-account-${tenantId}-${String(generation)}`;
}

/** The provider and mode a deployment works in (Stripe test or live, or the sandbox). */
type ProviderMode = Pick<PaymentsProvider, 'provider' | 'livemode'>;

/**
 * A stored account this deployment can use: Stripe hasn't disconnected it, and it was made with
 * this provider in this mode. One made in the sandbox, or with test keys before going live, is
 * someone else's to Stripe: it reads as not connected and connecting again replaces it.
 */
function isCurrent(
  row: PaymentAccountRow | undefined,
  mode: ProviderMode,
): row is PaymentAccountRow {
  return (
    row?.deauthorizedAt === null && row.provider === mode.provider && row.livemode === mode.livemode
  );
}

function statusOf(row: PaymentAccountRow): PaymentAccountStatus {
  return paymentAccountStatus({
    ...paymentAccountSnapshotOf(row),
    deauthorized: row.deauthorizedAt !== null,
  });
}

/** `GET /v1/payments/account` (AC-X-94): owners and managers. */
export async function readPaymentAccount(
  deps: Pick<PaymentsDeps, 'db' | 'provider'>,
  actor: Actor,
): Promise<PaymentAccountAnswer> {
  requirePermission(actor, 'payments.read');
  const row = await withMember(deps.db, actor.context, (tx) => findPaymentAccount(tx));
  return answerOf(
    isCurrent(row, deps.provider) ? row : undefined,
    can(actor.context, 'payments.manage'),
  );
}

/** The answer for a current account (`undefined`: none this deployment can use). */
export function answerOf(
  row: PaymentAccountRow | undefined,
  canManage: boolean,
): PaymentAccountAnswer {
  if (row?.deauthorizedAt !== null) {
    return PaymentAccountAnswerSchema.parse({
      status: 'not_connected',
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      due: [],
      eventuallyDue: [],
      dueBy: null,
      disabledReason: null,
      syncedAt: null,
      canManage,
    });
  }
  const snapshot = paymentAccountSnapshotOf(row);
  return PaymentAccountAnswerSchema.parse({
    status: statusOf(row),
    chargesEnabled: snapshot.chargesEnabled,
    payoutsEnabled: snapshot.payoutsEnabled,
    detailsSubmitted: snapshot.detailsSubmitted,
    // Past due first: those already stopped something.
    due: [...new Set([...snapshot.pastDue, ...snapshot.currentlyDue])],
    eventuallyDue: snapshot.eventuallyDue,
    dueBy: snapshot.currentDeadline,
    disabledReason: snapshot.disabledReason,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    canManage,
  });
}

/**
 * `POST /v1/payments/onboarding` (AC-X-93): the owner only. Creates the business's account the
 * first time (or after Stripe disconnected it) and answers a fresh Stripe-hosted onboarding link.
 * Two taps, two devices or a retry make one account: the key per business and generation, and
 * one row per business (the first insert wins; the loser's account is the same Stripe account
 * within Stripe's 24 hours).
 */
export async function startPaymentOnboarding(
  deps: PaymentsDeps,
  actor: Actor,
): Promise<PaymentOnboardingLink> {
  requirePermission(actor, 'payments.manage');
  const { context } = actor;
  let row = await withMember(deps.db, context, (tx) => findPaymentAccount(tx));
  if (isCurrent(row, deps.provider) && statusOf(row) === 'rejected') {
    throw new PaymentsRejectedError();
  }
  if (!isCurrent(row, deps.provider)) {
    row = await connectAccount(deps, actor, row);
  }
  const link = await deps.provider.createOnboardingLink({
    accountId: row.providerAccountId,
    returnUrl: `${deps.baseUrl}${PAYMENTS_PAGE}?stripe=return`,
    refreshUrl: `${deps.baseUrl}${PAYMENTS_PAGE}?stripe=refresh`,
  });
  return PaymentOnboardingLinkSchema.parse({
    url: link.url,
    expiresAt: (link.expiresAt ?? new Date(deps.clock.now().getTime() + 5 * 60_000)).toISOString(),
  });
}

async function connectAccount(
  deps: PaymentsDeps,
  actor: Actor,
  previous: PaymentAccountRow | undefined,
): Promise<PaymentAccountRow> {
  const { context } = actor;
  const generation = previous === undefined ? 1 : previous.generation + 1;
  const syncedAt = deps.clock.now();
  const account = await deps.provider.createAccount({
    tenantId: context.tenantId,
    idempotencyKey: accountIdempotencyKey(context.tenantId, generation),
  });
  const snapshot = snapshotOfStripeAccount(account);
  const input: NewPaymentAccount = {
    provider: deps.provider.provider,
    providerAccountId: account.id,
    generation,
    livemode: deps.provider.livemode,
    status: paymentAccountStatus({ ...snapshot, deauthorized: false }),
    snapshot,
    syncedAt,
    createdBy: UserIdSchema.parse(context.userId),
  };
  return withMember(deps.db, context, async (tx) => {
    const stored =
      previous === undefined
        ? await insertPaymentAccount(tx, input)
        : await replacePaymentAccount(tx, previous.id, previous.generation, input);
    if (stored === undefined) {
      // Another request connected it first: keep that one.
      const winner = await findPaymentAccount(tx);
      if (winner === undefined) throw new Error('payment account vanished while connecting');
      return winner;
    }
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId: context.userId },
      requestId: actor.requestId,
      change: {
        action: 'payments.account_created',
        entity: { type: 'payment_account', id: stored.id },
        before: null,
        after: { provider: stored.provider === 'stripe' ? 'stripe' : 'sandbox' },
      },
    });
    return stored;
  });
}

/** `POST /v1/payments/dashboard`: the owner's Express dashboard, once Stripe's pages are done. */
export async function paymentDashboardLink(
  deps: PaymentsDeps,
  actor: Actor,
): Promise<PaymentDashboardLink> {
  requirePermission(actor, 'payments.manage');
  const row = await withMember(deps.db, actor.context, (tx) => findPaymentAccount(tx));
  if (!isCurrent(row, deps.provider) || !row.detailsSubmitted) {
    throw new PaymentsNotOnboardedError();
  }
  const link = await deps.provider.createDashboardLink(row.providerAccountId);
  return PaymentDashboardLinkSchema.parse({ url: link.url });
}

/**
 * `POST /v1/payments/account/sync` (AC-X-94): the owner, after Stripe's pages send them back
 * (a webhook can lag the redirect). Answers the account as it stands after the read.
 */
export async function syncOwnPaymentAccount(
  deps: PaymentsDeps,
  actor: Actor,
): Promise<PaymentAccountAnswer> {
  requirePermission(actor, 'payments.manage');
  const row = await withMember(deps.db, actor.context, (tx) => findPaymentAccount(tx));
  if (isCurrent(row, deps.provider)) {
    try {
      await syncPaymentAccount(deps, actor.context.tenantId, {
        accountId: row.providerAccountId,
        actor: { kind: 'user', userId: actor.context.userId },
        requestId: actor.requestId,
      });
    } catch (error) {
      // Stripe refuses for good to show it (no longer the platform's): trying again won't help,
      // so answer what Pepper knows; its disconnection event settles it. A passing failure is
      // still the caller's "try again".
      if (!(error instanceof PaymentsProviderError) || error.retryable) throw error;
    }
  }
  return readPaymentAccount(deps, actor);
}

export interface SyncOptions {
  /** The Stripe account the caller means: a row now holding another one is left alone. */
  accountId: StripeAccountId;
  actor: AuditActor;
  requestId?: string | undefined;
  /** Runs in the same transaction as the change, applied or not (the webhook marks its event). */
  finish?: (tx: TenantTx) => Promise<void>;
}

export type SyncOutcome =
  | { applied: false; reason: 'no_account' | 'stale' }
  | { applied: true; before: PaymentAccountStatus; after: PaymentAccountStatus };

/**
 * Reads the business's account from Stripe and applies it (ADR-0067 §5–7): only when this read
 * is newer than the one stored (the time is taken before the call, so a read that started
 * earlier never wins), in one transaction with its audit entry and the owners' push when the
 * status changed. `tenantId` comes from the session or from `payment_account_tenant`.
 */
export async function syncPaymentAccount(
  deps: PaymentsDeps,
  tenantId: TenantId,
  options: SyncOptions,
): Promise<SyncOutcome> {
  const readAt = deps.clock.now();
  const account = await deps.provider.retrieveAccount(options.accountId);
  const snapshot = snapshotOfStripeAccount(account);
  const after = paymentAccountStatus({ ...snapshot, deauthorized: false });
  // Without a user: the owners' devices are reached for the push, as for any job.
  return withTenant(deps.db, tenantId, async (tx) => {
    const outcome = await applyRead(tx, deps, options, { snapshot, after, readAt });
    if (options.finish !== undefined) await options.finish(tx);
    return outcome;
  });
}

async function applyRead(
  tx: TenantTx,
  deps: PaymentsDeps,
  options: SyncOptions,
  read: {
    snapshot: ReturnType<typeof snapshotOfStripeAccount>;
    after: PaymentAccountStatus;
    readAt: Date;
  },
): Promise<SyncOutcome> {
  const row = await findPaymentAccount(tx, { lock: true });
  if (!isCurrent(row, deps.provider) || row.providerAccountId !== options.accountId) {
    return { applied: false, reason: 'no_account' };
  }
  const before = PaymentAccountStatusSchema.parse(row.status);
  const applied = await applyPaymentAccountSync(tx, {
    id: row.id,
    providerAccountId: row.providerAccountId,
    snapshot: read.snapshot,
    status: read.after,
    syncedAt: read.readAt,
  });
  if (applied === undefined) return { applied: false, reason: 'stale' };
  if (before !== read.after) {
    await appendAuditEntry(tx, {
      actor: options.actor,
      requestId: options.requestId,
      change: {
        action: 'payments.account_status_changed',
        entity: { type: 'payment_account', id: row.id },
        before: { status: before },
        after: { status: read.after },
      },
    });
    await pushOwners(tx, deps, {
      rowId: row.id,
      before,
      after: read.after,
      readAt: read.readAt,
      dueBy: applied.currentDeadline,
    });
  }
  return { applied: true, before, after: read.after };
}

/** The owners' push for a change worth telling (AC-X-102): one per change, keyed by it. */
export async function pushOwners(
  tx: TenantTx,
  deps: Pick<PaymentsDeps, 'outboxKey' | 'clock'>,
  change: {
    rowId: string;
    before: PaymentAccountStatus;
    after: PaymentAccountStatus;
    readAt: Date;
    dueBy: Date | null;
  },
): Promise<void> {
  const business = await findCurrentTenant(tx);
  if (business === undefined) return;
  const notice = paymentsNotice(change.before, change.after, {
    dueBy: change.dueBy,
    timeZone: business.timeZone,
  });
  if (notice === null) return;
  const owners = (await listMemberships(tx))
    .filter((membership) => membership.role === 'owner')
    .map((membership) => UserIdSchema.parse(membership.userId));
  await queuePushToMembers(tx, owners, notice, {
    key: deps.outboxKey,
    dedupeKey: OutboxDedupeKeySchema.parse(
      `payments:${change.rowId}:${change.after}:${String(change.readAt.getTime())}`,
    ),
    now: deps.clock.now(),
  });
}
