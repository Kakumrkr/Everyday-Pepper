import {
  fromZoned,
  toZoned,
  type ImportBatchId,
  type ImportFormat,
  type ImportReason,
  type ImportVisitStatus,
} from '@pepper/contracts';
import type { TenantTx } from '@pepper/db';
import { rowLabel, type RawVisit } from './rows.js';
import type { CellDate } from './values.js';

// A visits file's visits (S49, ADR-0050, AC-W1-22…24): each row's time in the business's zone,
// its service and staff member by name, past or upcoming, already in Pepper, or an upcoming
// time another booking holds. Pure: the service loads what the rows need through the
// `VisitBook` port, which the appointments module serves, and writes the plan through it.

const MINUTE_MS = 60_000;
/** A visit's length when neither the row nor a service says (a hidden service's default). */
export const DEFAULT_VISIT_MINUTES = 60;
/** The name of the hidden service for visits whose file names none. */
export const UNNAMED_SERVICE = 'Imported visit';

export interface VisitService {
  id: string;
  name: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceFromCents: number | null;
}

export interface VisitStaff {
  id: string;
  name: string;
}

/** What planning needs from the business. */
export interface VisitContext {
  timeZone: string;
  /** Every service, shown or hidden. */
  services: readonly VisitService[];
  /** The active staff members. */
  staff: readonly VisitStaff[];
  /** Who visits without a known staff member go to; `null` with no active staff. */
  defaultStaff: VisitStaff | null;
}

/** Time a staff member's bookings occupy (buffers included). */
export interface BusyTime {
  staffMemberId: string;
  from: Date;
  to: Date;
}

/** A visit to write. */
export interface NewVisit {
  id: string;
  clientId: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceFromCents: number | null;
  status: ImportVisitStatus;
  createdBy: string | null;
}

/**
 * What the import needs from the appointments module (ADR-0050 §2), in the caller's tenant
 * transaction. `@pepper/appointments` serves it (`importVisitBook`); the api and the worker pass
 * it in, so neither module imports the other.
 */
export interface VisitBook {
  context(tx: TenantTx, userId: string | null): Promise<VisitContext>;
  /** Busy time in [from, to) of every staff member. */
  busy(tx: TenantTx, from: Date, to: Date): Promise<BusyTime[]>;
  /** These clients' visits (not cancelled) starting in [from, to). */
  visitStarts(
    tx: TenantTx,
    clientIds: readonly string[],
    from: Date,
    to: Date,
  ): Promise<{ clientId: string; startsAt: Date }[]>;
  /** Creates hidden services (or finds one made since); returns them. */
  addHiddenServices(
    tx: TenantTx,
    services: readonly { name: string; durationMinutes: number }[],
  ): Promise<VisitService[]>;
  /**
   * Writes visits with no email and no reminder: past ones together, each upcoming one on its
   * own, so one whose time was taken meanwhile comes back in `conflicts` (by id).
   */
  writeVisits(
    tx: TenantTx,
    batchId: ImportBatchId,
    visits: readonly NewVisit[],
  ): Promise<{ conflicts: string[] }>;
  /** After a run: what follows from new bookings once (the insights re-run). */
  finished(tx: TenantTx): Promise<void>;
  /** Removes the batch's bookings nobody changed since. */
  undo(tx: TenantTx, batchId: ImportBatchId): Promise<{ deleted: number; kept: number }>;
}

/** A row the visit planner sees: its visit and whose it is. */
export interface VisitEntry {
  row: number;
  visit: RawVisit;
  /** The client: an existing one's id, or `row:<position>` for one the file creates. */
  clientKey: string;
}

/** What a visit row does. */
export interface PlannedVisit {
  outcome: 'create' | 'unchanged' | 'skipped' | 'conflict' | 'invalid';
  reasons: ImportReason[];
  startsAt: number;
  durationMinutes: number;
  /** The service's lowercased name; its id, or `null` for a hidden one to create. */
  serviceKey: string;
  serviceName: string;
  serviceId: string | null;
  staffId: string | null;
  staffName: string;
  status: ImportVisitStatus;
  priceCents: number | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
}

/** A plan's sentences for the owner, and what stops it. */
export interface VisitSummary {
  /** Hidden services to create: name and length. */
  newServices: { key: string; name: string; durationMinutes: number }[];
  notices: string[];
  problems: string[];
}

export const serviceKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/** The instant of a cell's date and minute: its own offset, else the business's zone. */
function instantOf(cell: CellDate, minute: number, timeZone: string): number {
  if (cell.offset !== null) {
    const { year, month, day } = cell.date;
    return Date.UTC(year, month - 1, day) + (minute - cell.offset) * MINUTE_MS;
  }
  return fromZoned(timeZone, cell.date, minute);
}

/** A visit's start, and its end when the file gives one. */
export function visitTimes(
  visit: RawVisit,
  timeZone: string,
): { start: number; end: number | null } | null {
  const minute = visit.time ?? visit.date.minute;
  if (minute === null) return null;
  const start = instantOf(visit.date, minute, timeZone);
  const end =
    visit.end?.minute === null || visit.end === null
      ? null
      : instantOf(visit.end, visit.end.minute, timeZone);
  return { start, end };
}

/** Minutes from a visit's start to its end, when the file gives an end. */
function spanMinutes(times: { start: number; end: number | null } | null): number | null {
  if (times === null) return null;
  const { start, end } = times;
  return end === null ? null : Math.round((end - start) / MINUTE_MS);
}

/** "Jan 5, 2:30 PM" in the business's zone. */
function when(instant: number, timeZone: string): string {
  const { month, day, minuteOfDay } = toZoned(timeZone, instant);
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const clock = `${String(((hour + 11) % 12) + 1)}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
  return `${months[month - 1] ?? ''} ${String(day)}, ${clock}`;
}

function mostCommon(values: readonly number[]): number | null {
  const counts = new Map<number, number>();
  let best: number | null = null;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (best === null || count > (counts.get(best) ?? 0)) best = value;
  }
  return best;
}

/** Finds a staff member by name, or by first name when exactly one has it. */
function staffByName(staff: readonly VisitStaff[], name: string): VisitStaff | undefined {
  const key = serviceKey(name);
  const exact = staff.find((member) => serviceKey(member.name) === key);
  if (exact !== undefined) return exact;
  const first = (text: string) => serviceKey(text).split(' ')[0] ?? '';
  const same = staff.filter((member) => first(member.name) === first(name));
  return same.length === 1 ? same[0] : undefined;
}

const overlaps = (a: { from: number; to: number }, b: { from: number; to: number }) =>
  a.from < b.to && b.from < a.to;

/**
 * Plans each visit in file order (AC-W1-22…24): its start in the business's zone, service and
 * staff member; past (completed, or no-show) or upcoming (confirmed); a visit the client
 * already has at that start is unchanged, one the file repeats is skipped, a cancelled one is
 * skipped, and an upcoming one whose time (with its service's buffers) overlaps another
 * booking of its staff member, in Pepper or earlier in the file, is a conflict.
 */
export function planVisits(
  format: ImportFormat,
  entries: readonly VisitEntry[],
  context: VisitContext,
  options: {
    now: number;
    busy: readonly BusyTime[];
    /** `${clientId}|${startMs}` of the visits the clients already have. */
    existing: ReadonlySet<string>;
  },
): { visits: PlannedVisit[]; summary: VisitSummary } {
  const { timeZone } = context;
  const services = new Map(context.services.map((service) => [serviceKey(service.name), service]));
  // Hidden services to create: the most common length their rows give.
  const unknown = new Map<string, { name: string; lengths: number[] }>();
  for (const { visit } of entries) {
    const name = visit.service ?? UNNAMED_SERVICE;
    const key = serviceKey(name);
    if (services.has(key)) continue;
    const entry = unknown.get(key) ?? { name, lengths: [] };
    const times = visitTimes(visit, timeZone);
    const length = visit.duration ?? spanMinutes(times);
    if (length !== null && length >= 5 && length <= 720) entry.lengths.push(length);
    unknown.set(key, entry);
  }
  const newServices = [...unknown].map(([key, { name, lengths }]) => ({
    key,
    name,
    durationMinutes: mostCommon(lengths) ?? DEFAULT_VISIT_MINUTES,
  }));
  const newByKey = new Map(newServices.map((service) => [service.key, service]));

  const busy = new Map<string, { from: number; to: number }[]>();
  for (const time of options.busy) {
    const list = busy.get(time.staffMemberId) ?? [];
    list.push({ from: time.from.getTime(), to: time.to.getTime() });
    busy.set(time.staffMemberId, list);
  }
  const seen = new Map<string, number>();
  const useOf = new Map<string, number>();
  const strangers = new Map<string, number>();
  let defaulted = 0;

  const visits = entries.map(({ row, visit, clientKey }): PlannedVisit => {
    const label = rowLabel(format, row);
    const serviceName = visit.service ?? UNNAMED_SERVICE;
    const key = serviceKey(serviceName);
    const known = services.get(key);
    const hidden = newByKey.get(key);
    const times = visitTimes(visit, timeZone);
    const start = times?.start ?? 0;
    const length =
      visit.duration ??
      spanMinutes(times) ??
      known?.durationMinutes ??
      hidden?.durationMinutes ??
      DEFAULT_VISIT_MINUTES;
    const member = visit.staff === null ? undefined : staffByName(context.staff, visit.staff);
    const staff = member ?? context.defaultStaff;
    const plan: PlannedVisit = {
      outcome: 'create',
      reasons: [],
      startsAt: start,
      durationMinutes: length,
      serviceKey: key,
      serviceName: known?.name ?? hidden?.name ?? serviceName,
      serviceId: known?.id ?? null,
      staffId: staff?.id ?? null,
      staffName: staff?.name ?? visit.staff ?? '',
      status:
        start < options.now ? (visit.status === 'no_show' ? 'no_show' : 'completed') : 'confirmed',
      priceCents: visit.priceCents ?? known?.priceFromCents ?? null,
      bufferBeforeMinutes: known?.bufferBeforeMinutes ?? 0,
      bufferAfterMinutes: known?.bufferAfterMinutes ?? 0,
    };
    const fail = (outcome: PlannedVisit['outcome'], reason: ImportReason): PlannedVisit => ({
      ...plan,
      outcome,
      reasons: [reason],
    });
    if (times === null) {
      return fail('invalid', {
        code: 'time_invalid',
        message: `${label}: the visit has no time. Add it, like 2:30 PM.`,
      });
    }
    if (length < 5 || length > 720) {
      return fail('invalid', {
        code: 'duration_invalid',
        message: `${label}: the visit ends before it starts or lasts over 12 hours. Check its end time.`,
      });
    }
    if (visit.status === 'cancelled') {
      return fail('skipped', {
        code: 'cancelled',
        message: `${label}: it was cancelled, so it isn’t imported.`,
      });
    }
    const visitKey = `${clientKey}|${String(start)}`;
    const earlier = seen.get(visitKey);
    if (earlier !== undefined) {
      return fail('skipped', {
        code: 'visit_duplicate',
        message: `${label}: the same visit as ${rowLabel(format, earlier).toLowerCase()}, so it’s skipped.`,
      });
    }
    seen.set(visitKey, row);
    if (options.existing.has(visitKey)) {
      return fail('unchanged', {
        code: 'visit_exists',
        message: `${label}: this visit is already in Pepper.`,
      });
    }
    if (plan.status === 'confirmed' && plan.staffId !== null) {
      const occupied = {
        from: start - plan.bufferBeforeMinutes * MINUTE_MS,
        to: start + (length + plan.bufferAfterMinutes) * MINUTE_MS,
      };
      const list = busy.get(plan.staffId) ?? [];
      const taken = list.find((other) => overlaps(occupied, other));
      if (taken !== undefined) {
        return fail('conflict', {
          code: 'conflict',
          message: `${label}: ${plan.staffName} already has a booking at ${when(Math.max(taken.from, occupied.from), timeZone)}, so this one is left out. Book it again from the calendar if it still stands.`,
        });
      }
      list.push(occupied);
      busy.set(plan.staffId, list);
    }
    useOf.set(key, (useOf.get(key) ?? 0) + 1);
    if (member === undefined) {
      if (visit.staff === null) defaulted += 1;
      else strangers.set(visit.staff, (strangers.get(visit.staff) ?? 0) + 1);
    }
    return plan;
  });

  const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;
  const notices: string[] = [];
  const problems: string[] = [];
  const created = newServices.filter((service) => (useOf.get(service.key) ?? 0) > 0);
  for (const service of created) {
    notices.push(
      `“${service.name}” isn’t one of your services: ${plural(useOf.get(service.key) ?? 0, 'visit brings', 'visits bring')} it in as a hidden service of ${String(service.durationMinutes)} minutes.`,
    );
  }
  const fallback = context.defaultStaff;
  if (fallback === null && (strangers.size > 0 || defaulted > 0)) {
    problems.push('Add yourself to your team first: every visit needs someone it was with.');
  } else if (fallback !== null) {
    for (const [name, n] of strangers) {
      notices.push(
        `“${name}” isn’t on your team: ${plural(n, 'visit goes', 'visits go')} to ${fallback.name}.`,
      );
    }
    if (defaulted > 0) {
      notices.push(
        `${plural(defaulted, 'visit doesn’t say', 'visits don’t say')} who it was with, so ${defaulted === 1 ? 'it goes' : 'they go'} to ${fallback.name}.`,
      );
    }
  }
  return { visits, summary: { newServices: created, notices, problems } };
}
