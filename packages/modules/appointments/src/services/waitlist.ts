import {
  CANCELLABLE_WAITLIST_STATUSES,
  StaffMemberIdSchema,
  WaitlistChangeSchema,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistQuerySchema,
  WaitlistStatusSchema,
  minutesOfDay,
  type WaitlistChange,
  type WaitlistEntry,
  type WaitlistEntryId,
  type WaitlistEntryInput,
  type WaitlistQuery,
  type WaitlistWindow,
  type AvailableSlot,
  type StaffMemberId,
} from '@pepper/contracts';
import {
  auditActorOf,
  ForbiddenError,
  recordSmsConsent,
  requirePermission,
  systemClock,
  type Actor,
  type Clock,
} from '@pepper/core';
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
  type ServiceRow,
  type TenantTx,
} from '@pepper/db';
import { fromZoned, parseDate } from '../availability/zoned-time.js';
import { toAvailableSlot, waitlistExpiry } from '../bookings/planning.js';
import { windowsHold } from '../bookings/waitlist-ranking.js';
import { serviceToBook, slotsFor, type TemplateRuleDefaultsOf } from './availability.js';
import { ownStaffMemberId } from './bookings.js';
import { findClientToBook } from './clients.js';
import { withdrawOffersOfEntry } from './smart-waitlist.js';
import type { WaitlistOptInNotify } from './waitlist-texts.js';
import {
  ServiceNotFoundError,
  StaffMemberNotFoundError,
  WaitlistEntryNotChangeableError,
  WaitlistEntryNotFoundError,
  WaitlistExpiredError,
  WaitlistTimesFreeError,
} from '../errors.js';
import { staffOwner, toWaitlistEntry, waitlistAuditValues } from '../mapping.js';

// The waitlist (ADR-0017): clients waiting for a service at times that are full. It follows
// the bookings' permissions: owners and managers manage every entry; staff only entries for
// their own staff member (an entry for "anyone" is the business's to hand out). Offering freed
// slots to the best entry is the smart waitlist (Phase 8). It is for times that are full: an
// entry whose windows still hold a free time is refused with those times (S44, AC-W5-2), so
// whoever adds it (the app or the AI) books instead; the domain judges "full", not the caller.

/** How many free times a refused waitlist entry lists. */
export const WAITLIST_FREE_TIMES_SHOWN = 3;

export interface WaitlistOptions {
  clock?: Clock;
  /** The template's booking rules, as availability takes them (the app passes them). */
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /** Queues the opt-in text after the client's yes to texts about openings (S79, the api's). */
  optIn?: WaitlistOptInNotify;
}

/**
 * Adds a client to the waitlist; it expires when its last window ends. `WaitlistTimesFreeError`
 * when a time inside a window can still be booked.
 */
export async function addToWaitlist(
  db: Database,
  actor: Actor,
  input: WaitlistEntryInput,
  options: WaitlistOptions = {},
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
  options: WaitlistOptions = {},
): Promise<WaitlistEntry> {
  requirePermission(actor, 'bookings.manage');
  const entry = WaitlistEntryInputSchema.parse(input);
  // Only a person records what a client agreed to (S79): never the AI, whatever its arguments.
  if (entry.smsConsent !== null && actor.via === 'ai') throw new ForbiddenError();
  const now = (options.clock ?? systemClock).now();
  if (entry.staffMemberId === null) {
    requirePermission(actor, 'bookings.manage', { ownerUserId: null });
  } else {
    const staff = await findStaffMember(tx, entry.staffMemberId);
    if (staff === undefined) throw new StaffMemberNotFoundError();
    requirePermission(actor, 'bookings.manage', staffOwner(staff));
  }
  const service = await findService(tx, entry.serviceId);
  if (service === undefined) throw new ServiceNotFoundError();
  await findClientToBook(tx, entry.clientId, entry.clientContact);
  const tenant = await findCurrentTenant(tx);
  // withMember always has a tenant; its row is visible to every member.
  if (tenant === undefined) throw new Error('No tenant in this transaction');
  const expiresAt = waitlistExpiry(entry.windows, tenant.timeZone);
  if (expiresAt <= now.getTime()) throw new WaitlistExpiredError();
  const free = await freeTimesIn(tx, {
    service,
    staffMemberId: entry.staffMemberId,
    windows: entry.windows,
    timeZone: tenant.timeZone,
    now: now.getTime(),
    templateRuleDefaults: options.templateRuleDefaults,
  });
  if (free.length > 0) throw new WaitlistTimesFreeError(free);

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
  if (entry.smsConsent !== null) {
    // The client told the team yes to texts about openings (AC-X-223): recorded as the member.
    await recordSmsConsent(
      tx,
      {
        phone: entry.smsConsent.phone,
        source: 'staff_recorded',
        clientId: entry.clientId,
        wordingVersion: entry.smsConsent.wordingVersion,
        givenAt: now,
      },
      { actor: auditActorOf(actor), requestId: actor.requestId },
    );
    await options.optIn?.(tx, {
      phone: entry.smsConsent.phone,
      entryId: row.id,
      details: { businessName: tenant.name, serviceName: service.name },
    });
  }
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
  const { all, serviceId, clientId, limit } = WaitlistQuerySchema.parse(query);
  const now = (options.clock ?? systemClock).now();
  const own = await ownStaffMemberId(tx, actor, 'bookings.read');
  const entries = await listWaitlistEntries(tx, {
    now,
    all,
    limit,
    ...(serviceId !== undefined && { serviceId }),
    ...(clientId !== undefined && { clientId }),
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
  // Off the list means off any time offered meanwhile: their link reads as expired.
  await withdrawOffersOfEntry(tx, id);
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

/**
 * The earliest times inside the windows that can be booked now, with the staff member or anyone
 * who offers the service (the same engine and rules as booking), whose whole appointment fits
 * the window as the matcher would offer it; at most `WAITLIST_FREE_TIMES_SHOWN`. A window that
 * has begun counts from now.
 */
async function freeTimesIn(
  tx: TenantTx,
  search: {
    service: ServiceRow;
    staffMemberId: StaffMemberId | null;
    windows: readonly WaitlistWindow[];
    timeZone: string;
    now: number;
    templateRuleDefaults: TemplateRuleDefaultsOf | undefined;
  },
): Promise<AvailableSlot[]> {
  // One load over the windows' whole span, then only the times that fit inside a window.
  const bounds = search.windows.map((window) => {
    const day = parseDate(window.date);
    return {
      from: fromZoned(search.timeZone, day, minutesOfDay(window.start)),
      to: fromZoned(search.timeZone, day, minutesOfDay(window.end)),
    };
  });
  const from = Math.max(Math.min(...bounds.map((b) => b.from)), search.now);
  const to = Math.max(...bounds.map((b) => b.to));
  if (from >= to) return [];
  const slots = await slotsFor(tx, {
    service: serviceToBook(search.service),
    staffMemberIds: search.staffMemberId === null ? undefined : [search.staffMemberId],
    from,
    to,
    now: search.now,
    templateRuleDefaults: search.templateRuleDefaults,
  });
  // As the matcher offers them: the whole appointment inside a window.
  const free = slots
    .filter((slot) =>
      windowsHold(search.windows, search.timeZone, slot.start, search.service.durationMinutes),
    )
    .map(toAvailableSlot);
  return free
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, WAITLIST_FREE_TIMES_SHOWN);
}
