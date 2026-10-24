import {
  CANCELLABLE_WAITLIST_STATUSES,
  StaffMemberIdSchema,
  WaitlistChangeSchema,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistQuerySchema,
  WaitlistStatusSchema,
  type WaitlistChange,
  type WaitlistEntry,
  type WaitlistEntryId,
  type WaitlistEntryInput,
  type WaitlistQuery,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, systemClock, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  cancelWaitlistEntry as cancelWaitlistEntryRow,
  findCurrentTenant,
  findService,
  findStaffMember,
  insertWaitlistEntry,
  listWaitlistEntries,
  lockWaitlistEntry,
  withMember,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { waitlistExpiry } from '../bookings/planning.js';
import { ownStaffMemberId } from './bookings.js';
import { findClientToBook } from './clients.js';
import {
  ServiceNotFoundError,
  StaffMemberNotFoundError,
  WaitlistEntryNotChangeableError,
  WaitlistEntryNotFoundError,
  WaitlistExpiredError,
} from '../errors.js';
import { staffOwner, toWaitlistEntry, waitlistAuditValues } from '../mapping.js';

// The waitlist (ADR-0017): clients waiting for a service at times that are full. It follows
// the bookings' permissions: owners and managers manage every entry; staff only entries for
// their own staff member (an entry for "anyone" is the business's to hand out). Offering freed
// slots to the best entry is the smart waitlist (Phase 8).

/** Adds a client to the waitlist; it expires when its last window ends. */
export async function addToWaitlist(
  db: Database,
  actor: Actor,
  input: WaitlistEntryInput,
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry> {
  requirePermission(actor, 'bookings.manage');
  const entry = WaitlistEntryInputSchema.parse(input);
  return withMember(db, actor.context, (tx) => addToWaitlistIn(tx, actor, entry, options));
}

/** `addToWaitlist` inside the caller's transaction (the AI's `add_to_waitlist`, S37). */
export async function addToWaitlistIn(
  tx: TenantTx,
  actor: Actor,
  input: WaitlistEntryInput,
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry> {
  requirePermission(actor, 'bookings.manage');
  const entry = WaitlistEntryInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now();
  if (entry.staffMemberId === null) {
    requirePermission(actor, 'bookings.manage', { ownerUserId: null });
  } else {
    const staff = await findStaffMember(tx, entry.staffMemberId);
    if (staff === undefined) throw new StaffMemberNotFoundError();
    requirePermission(actor, 'bookings.manage', staffOwner(staff));
  }
  if ((await findService(tx, entry.serviceId)) === undefined) throw new ServiceNotFoundError();
  await findClientToBook(tx, entry.clientId, entry.clientContact);
  const tenant = await findCurrentTenant(tx);
  // withMember always has a tenant; its row is visible to every member.
  if (tenant === undefined) throw new Error('No tenant in this transaction');
  const expiresAt = waitlistExpiry(entry.windows, tenant.timeZone);
  if (expiresAt <= now.getTime()) throw new WaitlistExpiredError();

  const row = await insertWaitlistEntry(tx, {
    clientId: entry.clientId,
    serviceId: entry.serviceId,
    staffMemberId: entry.staffMemberId,
    windows: entry.windows,
    expiresAt: new Date(expiresAt),
    createdBy: actor.context.userId,
  });
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'waitlist_entry.created',
      entity: { type: 'waitlist_entry', id: row.id },
      before: null,
      after: waitlistAuditValues(row),
    },
    requestId: actor.requestId,
  });
  return toWaitlistEntry(row, now);
}

/** Waitlist entries, longest waiting first; open ones only unless `all`. */
export async function listWaitlist(
  db: Database,
  actor: Actor,
  query: WaitlistQuery = {},
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry[]> {
  requirePermission(actor, 'bookings.read');
  return withMember(db, actor.context, (tx) => listWaitlistIn(tx, actor, query, options));
}

/** `listWaitlist` inside the caller's transaction (the AI's reads, S37). */
export async function listWaitlistIn(
  tx: TenantTx,
  actor: Actor,
  query: WaitlistQuery = {},
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry[]> {
  requirePermission(actor, 'bookings.read');
  const { all, serviceId, limit } = WaitlistQuerySchema.parse(query);
  const now = (options.clock ?? systemClock).now();
  const own = await ownStaffMemberId(tx, actor, 'bookings.read');
  const entries = await listWaitlistEntries(tx, {
    now,
    all,
    limit,
    ...(serviceId !== undefined && { serviceId }),
  });
  // Staff reach only entries for their own staff member (RLS enforces the same).
  const rows =
    own === undefined ? entries : entries.filter((e) => own !== null && e.staffMemberId === own);
  return rows.map((row) => toWaitlistEntry(row, now));
}

/** Takes an entry off the list (from waiting or offered). */
export async function changeWaitlistEntry(
  db: Database,
  actor: Actor,
  entryId: WaitlistEntryId,
  change: WaitlistChange,
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry> {
  requirePermission(actor, 'bookings.manage');
  return withMember(db, actor.context, (tx) =>
    changeWaitlistEntryIn(tx, actor, entryId, change, options),
  );
}

/** `changeWaitlistEntry` inside the caller's transaction (undoing `add_to_waitlist`, S37). */
export async function changeWaitlistEntryIn(
  tx: TenantTx,
  actor: Actor,
  entryId: WaitlistEntryId,
  change: WaitlistChange,
  options: { clock?: Clock } = {},
): Promise<WaitlistEntry> {
  requirePermission(actor, 'bookings.manage');
  const id = WaitlistEntryIdSchema.parse(entryId);
  WaitlistChangeSchema.parse(change);
  const now = (options.clock ?? systemClock).now();
  const row = await lockWaitlistEntry(tx, id);
  if (row === undefined) throw new WaitlistEntryNotFoundError();
  const staff =
    row.staffMemberId === null
      ? undefined
      : await findStaffMember(tx, StaffMemberIdSchema.parse(row.staffMemberId));
  requirePermission(
    actor,
    'bookings.manage',
    staff === undefined ? { ownerUserId: null } : staffOwner(staff),
  );
  if (!CANCELLABLE_WAITLIST_STATUSES.includes(WaitlistStatusSchema.parse(row.status))) {
    throw new WaitlistEntryNotChangeableError();
  }
  const updated = await cancelWaitlistEntryRow(tx, id);
  // The row is locked, so it is still there.
  if (updated === undefined) throw new WaitlistEntryNotFoundError();
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'waitlist_entry.updated',
      entity: { type: 'waitlist_entry', id: updated.id },
      before: waitlistAuditValues(row),
      after: waitlistAuditValues(updated),
    },
    requestId: actor.requestId,
  });
  return toWaitlistEntry(updated, now);
}
