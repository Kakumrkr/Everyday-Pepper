import {
  BusinessDeletionRequestSchema,
  confirmsBusinessName,
  DELETION_GRACE_DAYS,
  TenantIdSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type BusinessDeletionRequest,
  type DeletionStatus,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  cancelAccountDeletion as cancelAccountDeletionRow,
  cancelCurrentTenantDeletion,
  cancelPendingOutboxEmails,
  countOwners,
  deleteAccountIfDue,
  deleteCurrentTenantIfDue,
  deleteInvitesTo,
  findAccountDeletion,
  findCurrentTenant,
  findCurrentTenantDeletion,
  isNotDueForDeletion,
  listAccountsDueForDeletion,
  listTenantsDueForDeletion,
  listUserBusinesses,
  scheduleAccountDeletion as scheduleAccountDeletionRow,
  scheduleCurrentTenantDeletion,
  withMember,
  withTenant,
  withUser,
  type Database,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import type { Clock } from '../clock.js';
import {
  AccountBeingDeletedError,
  AccountOwnsBusinessError,
  DeletionNameMismatchError,
} from '../errors.js';

// Deleting a business or an account (S51.2, ADR-0054, AC-W1-40…42). Either is scheduled for
// `DELETION_GRACE_DAYS` ahead and can be kept until then; the worker's pass then deletes it
// for good. While a business waits, its booking page takes nothing new and Pepper sends its
// clients no email; its team keeps working in it. While an account waits, it signs in as usual
// (only the browser that asked stays signed in), so its owner can still change their mind.

const DAY_MS = 86_400_000;

/** The day a deletion asked for at `now` is done. */
export function deletionDueFrom(now: Date): Date {
  return new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
}

function statusOf(dueAt: Date | null): DeletionStatus {
  return { dueAt: dueAt === null ? null : UtcDateTimeSchema.parse(dueAt.toISOString()) };
}

/** Whether the actor's business is being deleted, and when. Every member may see it. */
export async function businessDeletion(db: Database, actor: Actor): Promise<DeletionStatus> {
  requirePermission(actor, 'business.read');
  return statusOf(await withMember(db, actor.context, findCurrentTenantDeletion));
}

/**
 * Schedules the actor's business for deletion (owners only), once its name is typed: audited
 * as `business.deletion_scheduled`, and the emails it has waiting are taken back. Asking again
 * keeps the first day. Throws `DeletionNameMismatchError` for another name.
 */
export async function scheduleBusinessDeletion(
  db: Database,
  actor: Actor,
  request: BusinessDeletionRequest,
  options: { clock: Clock },
): Promise<DeletionStatus> {
  requirePermission(actor, 'business.delete');
  const { confirmName } = BusinessDeletionRequestSchema.parse(request);
  const now = options.clock.now();
  return withMember(db, actor.context, async (tx) => {
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new Error('No tenant in this transaction');
    if (!confirmsBusinessName(confirmName, tenant.name)) throw new DeletionNameMismatchError();
    const result = await scheduleCurrentTenantDeletion(tx, deletionDueFrom(now));
    if (result === undefined) throw new Error('No tenant in this transaction');
    if (result.scheduled) {
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'business.deletion_scheduled',
          entity: { type: 'tenant', id: tenant.id },
          before: null,
          after: { dueAt: UtcDateTimeSchema.parse(result.dueAt.toISOString()) },
        },
        requestId: actor.requestId,
      });
      await cancelPendingOutboxEmails(tx, now);
    }
    return statusOf(result.dueAt);
  });
}

/**
 * Keeps the actor's business (owners only), audited as `business.deletion_cancelled`; nothing
 * happens when it wasn't being deleted. Throws `AccountBeingDeletedError` when the actor is its
 * only owner and their own account is being deleted (the business would outlive them).
 */
export async function cancelBusinessDeletion(db: Database, actor: Actor): Promise<DeletionStatus> {
  requirePermission(actor, 'business.delete');
  const accountDueAt = await findAccountDeletion(db, actor.context.userId);
  return withMember(db, actor.context, async (tx) => {
    const dueAt = await findCurrentTenantDeletion(tx);
    if (dueAt === null) return statusOf(null);
    if (accountDueAt !== null && (await countOwners(tx)) <= 1) {
      throw new AccountBeingDeletedError();
    }
    if (await cancelCurrentTenantDeletion(tx)) {
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'business.deletion_cancelled',
          entity: { type: 'tenant', id: actor.context.tenantId },
          before: { dueAt: UtcDateTimeSchema.parse(dueAt.toISOString()) },
          after: null,
        },
        requestId: actor.requestId,
      });
    }
    return statusOf(null);
  });
}

/** Whether the signed-in account is being deleted, and when. */
export async function accountDeletion(db: Database, userId: UserId): Promise<DeletionStatus> {
  return statusOf(await findAccountDeletion(db, UserIdSchema.parse(userId)));
}

/**
 * The businesses `userId` is the only owner of and that aren't being deleted: an account in
 * any of them can't be deleted (`AccountOwnsBusinessError`).
 */
async function soleOwnedLiveBusinesses(db: Database, userId: UserId): Promise<TenantId[]> {
  const businesses = await withUser(db, userId, listUserBusinesses);
  const held: TenantId[] = [];
  for (const business of businesses) {
    if (business.role !== 'owner') continue;
    const tenantId = TenantIdSchema.parse(business.tenantId);
    const alone = await withTenant(db, tenantId, async (tx) => {
      if ((await findCurrentTenantDeletion(tx)) !== null) return false;
      return (await countOwners(tx)) <= 1;
    });
    if (alone) held.push(tenantId);
  }
  return held;
}

/**
 * Schedules the signed-in account for deletion (the caller has checked its password) and ends
 * every session but `sessionId`. Asking again keeps the first day. Throws
 * `AccountOwnsBusinessError` when it is the only owner of a business that isn't being deleted.
 * `userId` and `sessionId` come from the authenticated session.
 */
export async function scheduleAccountDeletion(
  db: Database,
  session: { userId: UserId; sessionId: string },
  options: { clock: Clock },
): Promise<DeletionStatus> {
  const userId = UserIdSchema.parse(session.userId);
  if ((await soleOwnedLiveBusinesses(db, userId)).length > 0) throw new AccountOwnsBusinessError();
  const dueAt = await scheduleAccountDeletionRow(
    db,
    userId,
    deletionDueFrom(options.clock.now()),
    session.sessionId,
  );
  return statusOf(dueAt);
}

/** Keeps the signed-in account; nothing happens when it wasn't being deleted. */
export async function cancelAccountDeletion(db: Database, userId: UserId): Promise<DeletionStatus> {
  await cancelAccountDeletionRow(db, UserIdSchema.parse(userId));
  return statusOf(null);
}

export interface DeletionPassOptions {
  clock: Clock;
  /**
   * Runs before a due business's rows are deleted, to delete what it keeps outside the
   * database (its photos' stored images). A failure leaves the business for the next pass.
   */
  beforeBusinessDeleted?: (tenantId: TenantId) => Promise<void>;
}

export interface DeletionPassResult {
  businesses: number;
  accounts: number;
  /** Due, but left for the next pass (stored images not deleted, or still a business's only owner). */
  deferred: number;
}

const PAGE = 50;
// The most a listing returns; past this many deferred in one pass, the rest wait for the next.
const MAX_LISTED = 1000;

/**
 * Deletes for good every business and account whose day has come (AC-W1-41, AC-W1-42):
 * businesses first (their stored images, then every row), then accounts (their invites in
 * each business they belong to, then the account with its sign-in, sessions and memberships).
 * An account that is again the only owner of a business that isn't being deleted waits. Safe
 * to run in several workers at once: each delete checks the day again and is idempotent.
 */
export async function runDueDeletions(
  db: Database,
  options: DeletionPassOptions,
): Promise<DeletionPassResult> {
  const now = options.clock.now();
  const result: DeletionPassResult = { businesses: 0, accounts: 0, deferred: 0 };
  const deferredTenants = new Set<string>();
  for (;;) {
    const due = (
      await listTenantsDueForDeletion(db, now, Math.min(PAGE + deferredTenants.size, MAX_LISTED))
    ).filter((id) => !deferredTenants.has(id));
    if (due.length === 0) break;
    for (const tenantId of due) {
      try {
        await options.beforeBusinessDeleted?.(tenantId);
      } catch {
        deferredTenants.add(tenantId);
        result.deferred += 1;
        continue;
      }
      const deleted = await withTenant(db, tenantId, (tx) =>
        deleteCurrentTenantIfDue(tx, now),
      ).catch((error: unknown) => {
        // The database's own clock says the day hasn't come (this clock runs ahead of it).
        if (isNotDueForDeletion(error)) return null;
        throw error;
      });
      if (deleted === true) {
        result.businesses += 1;
      } else {
        // Kept, deleted by another worker meanwhile, or not due by the database: once a pass.
        deferredTenants.add(tenantId);
        if (deleted === null) result.deferred += 1;
      }
    }
  }
  const deferredAccounts = new Set<string>();
  for (;;) {
    const due = (
      await listAccountsDueForDeletion(db, now, Math.min(PAGE + deferredAccounts.size, MAX_LISTED))
    ).filter((account) => !deferredAccounts.has(account.id));
    if (due.length === 0) break;
    for (const account of due) {
      if ((await soleOwnedLiveBusinesses(db, account.id)).length > 0) {
        deferredAccounts.add(account.id);
        result.deferred += 1;
        continue;
      }
      for (const business of await withUser(db, account.id, listUserBusinesses)) {
        await withTenant(db, TenantIdSchema.parse(business.tenantId), (tx) =>
          deleteInvitesTo(tx, account.email),
        );
      }
      if (await deleteAccountIfDue(db, account.id, now)) result.accounts += 1;
      else deferredAccounts.add(account.id);
    }
  }
  return result;
}
