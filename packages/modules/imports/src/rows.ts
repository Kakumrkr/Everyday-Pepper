import {
  ClientEmailSchema,
  normalizePhone,
  PhoneSchema,
  type ClientBirthday,
  type ImportField,
  type ImportFormat,
  type ImportMapping,
  type ImportReason,
  type ImportReasonCode,
  type ImportRowOutcome,
} from '@pepper/contracts';
import { createHash } from 'node:crypto';
import type { Table, TableRow } from './parse.js';
import {
  readBirthday,
  readDate,
  readDuration,
  readPrice,
  readStatus,
  readTags,
  readTime,
  type CellDate,
  type CellStatus,
} from './values.js';

// A file's rows as clients (S48, ADR-0049, AC-W1-3, AC-W1-18): each row's name, email, phone
// and external id under a mapping, checked with a reason the owner can act on, then planned
// against the business's clients: create, merge (fill empty fields), unchanged, or skip.
// Pure: the service loads the clients a file can match and applies the plan.

/** The longest external id kept. */
const MAX_EXTERNAL_ID = 200;
const MAX_NAME = 120;

/** A visits file's visit as its cells say it, before the business's zone and menu (S49). */
export interface RawVisit {
  date: CellDate;
  /** A separate time column's minutes after midnight. */
  time: number | null;
  /** An end column: a time, or a date and time. */
  end: CellDate | null;
  duration: number | null;
  service: string | null;
  staff: string | null;
  priceCents: number | null;
  status: CellStatus;
  visitId: string | null;
}

/**
 * A row under the mapping. `valid` rows have a name, only valid emails and phones and, in a
 * visits file, a visit that can be read; `warnings` are reasons that don't stop the row (a
 * birthday that can't be read, tags cut short, a price that can't be read).
 */
export interface MappedRow {
  row: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  tags: string[];
  birthday: ClientBirthday | null;
  /** A visits file's visit; `null` in a client file, or when it can't be read. */
  visit: RawVisit | null;
  /** The row's identity for a later re-import (name, email, phone, external id). */
  hash: string;
  valid: boolean;
  reasons: ImportReason[];
  warnings: ImportReason[];
}

/** Reasons that never stop a row. */
export const WARNING_CODES: ReadonlySet<ImportReasonCode> = new Set([
  'birthday_invalid',
  'tags_cut',
  'price_invalid',
]);

/** "Row 14" in a spreadsheet, "Item 3" of a JSON list, "Line 7" of a JSONL file. */
export function rowLabel(format: ImportFormat, row: number): string {
  return `${format === 'csv' ? 'Row' : format === 'json' ? 'Item' : 'Line'} ${String(row)}`;
}

/** Shows a value from the file in a sentence, cut short when long. */
function quote(value: string): string {
  return `“${value.length > 40 ? `${value.slice(0, 39)}…` : value}”`;
}

type Columns = Record<
  | 'name'
  | 'first'
  | 'last'
  | 'email'
  | 'phone'
  | 'externalId'
  | 'birthday'
  | 'tags'
  | 'date'
  | 'time'
  | 'end'
  | 'duration'
  | 'service'
  | 'staff'
  | 'price'
  | 'status'
  | 'visitId',
  number[]
>;

/** Each row of the table under `mapping` (columns the table doesn't have are ignored). */
export function mapRows(table: Table, mapping: ImportMapping): MappedRow[] {
  const index = new Map(table.columns.map((column, i) => [column, i]));
  const of = (field: ImportField) =>
    mapping.flatMap(({ column, field: f }) => {
      const i = index.get(column);
      return f === field && i !== undefined ? [i] : [];
    });
  const columns: Columns = {
    name: of('name'),
    first: of('first_name'),
    last: of('last_name'),
    email: of('email'),
    phone: of('phone'),
    externalId: of('external_id'),
    birthday: of('birthday'),
    tags: of('tags'),
    date: of('visit_date'),
    time: of('visit_time'),
    end: of('visit_end'),
    duration: of('duration'),
    service: of('service'),
    staff: of('staff'),
    price: of('price'),
    status: of('status'),
    visitId: of('visit_id'),
  };
  return table.rows.map((row) => mapRow(table.format, row, columns));
}

const MAX_VALUE = 120;

function mapRow(format: ImportFormat, { row, cells }: TableRow, columns: Columns): MappedRow {
  const label = rowLabel(format, row);
  const reasons: ImportReason[] = [];
  const values = (indexes: number[]) =>
    indexes.map((i) => (cells[i] ?? '').replace(/\s+/g, ' ').trim()).filter((v) => v !== '');

  const full = values(columns.name)[0];
  const parts = [...values(columns.first).slice(0, 1), ...values(columns.last).slice(0, 1)];
  let name: string | null = full ?? (parts.length > 0 ? parts.join(' ') : null);
  if (name === null) {
    reasons.push({ code: 'no_name', message: `${label}: there’s no name. Add the client’s name.` });
  } else if (name.length > MAX_NAME) {
    reasons.push({
      code: 'name_too_long',
      message: `${label}: the name is longer than ${String(MAX_NAME)} characters. Shorten it.`,
    });
    name = name.slice(0, MAX_NAME);
  }

  const emails = values(columns.email);
  const email =
    emails.map((v) => ClientEmailSchema.safeParse(v)).find((r) => r.success)?.data ?? null;
  const [badEmail] = emails;
  if (email === null && badEmail !== undefined) {
    reasons.push({
      code: 'email_invalid',
      message: `${label}: ${quote(badEmail)} isn’t an email address. Fix it or leave it empty.`,
    });
  }

  const phones = values(columns.phone);
  const phone =
    phones.map((v) => PhoneSchema.safeParse(normalizePhone(v))).find((r) => r.success)?.data ??
    null;
  const [badPhone] = phones;
  if (phone === null && badPhone !== undefined) {
    reasons.push({ code: 'phone_invalid', message: `${label}: ${phoneProblem(badPhone)}` });
  }

  let externalId = values(columns.externalId)[0] ?? null;
  if (externalId !== null && externalId.length > MAX_EXTERNAL_ID) {
    reasons.push({
      code: 'value_too_long',
      message: `${label}: the client id is longer than ${String(MAX_EXTERNAL_ID)} characters.`,
    });
    externalId = null;
  }

  const warnings: ImportReason[] = [];
  const [birthdayCell] = values(columns.birthday);
  let birthday: ClientBirthday | null = null;
  if (birthdayCell !== undefined) {
    birthday = readBirthday(birthdayCell);
    if (birthday === null) {
      warnings.push({
        code: 'birthday_invalid',
        message: `${label}: the birthday ${quote(birthdayCell)} can’t be read, so it’s left out. Write it as 4/12/1990 or April 12.`,
      });
    }
  }
  const { tags, cut } = readTags(values(columns.tags));
  if (cut) {
    warnings.push({
      code: 'tags_cut',
      message: `${label}: a client keeps up to 20 tags of up to 40 characters, so some are left out.`,
    });
  }

  const visit =
    columns.date.length === 0 ? null : mapVisit(label, values, columns, reasons, warnings);

  return {
    row,
    name,
    email,
    phone,
    externalId,
    tags,
    birthday,
    visit,
    hash: rowHash(name, email, phone, externalId),
    valid: reasons.length === 0,
    reasons,
    warnings,
  };
}

/** A visits file's visit from its cells; reasons for what can't be read. */
function mapVisit(
  label: string,
  values: (indexes: number[]) => string[],
  columns: Columns,
  reasons: ImportReason[],
  warnings: ImportReason[],
): RawVisit | null {
  const before = reasons.length;
  const [dateCell] = values(columns.date);
  const date = dateCell === undefined ? null : readDate(dateCell);
  if (date === null) {
    reasons.push({
      code: 'date_invalid',
      message:
        dateCell === undefined
          ? `${label}: there’s no visit date. Add it, like 1/5/2026.`
          : `${label}: the date ${quote(dateCell)} can’t be read. Write it like 1/5/2026 or 2026-01-05.`,
    });
  }
  const [timeCell] = values(columns.time);
  const time = timeCell === undefined ? null : readTime(timeCell);
  if (timeCell !== undefined && time === null) {
    reasons.push({
      code: 'time_invalid',
      message: `${label}: the time ${quote(timeCell)} can’t be read. Write it like 2:30 PM or 14:30.`,
    });
  }
  if (date !== null && date.minute === null && timeCell === undefined) {
    reasons.push({
      code: 'time_invalid',
      message: `${label}: the visit has no time. Add it, like 2:30 PM.`,
    });
  }
  const [endCell] = values(columns.end);
  let end: CellDate | null = null;
  if (endCell !== undefined) {
    // A time alone ends on the visit's own day; otherwise it's a date and time.
    const minute = readTime(endCell);
    if (minute === null) end = readDate(endCell);
    else if (date !== null) end = { date: date.date, minute, offset: date.offset };
    if (end?.minute === null) end = null;
    if (end === null && date !== null) {
      reasons.push({
        code: 'time_invalid',
        message: `${label}: the end time ${quote(endCell)} can’t be read. Write it like 3:15 PM.`,
      });
    }
  }
  const [durationCell] = values(columns.duration);
  const duration = durationCell === undefined ? null : readDuration(durationCell);
  if (durationCell !== undefined && (duration === null || duration < 5 || duration > 720)) {
    reasons.push({
      code: 'duration_invalid',
      message: `${label}: the length ${quote(durationCell)} isn’t between 5 minutes and 12 hours.`,
    });
  }
  const [priceCell] = values(columns.price);
  const priceCents = priceCell === undefined ? null : readPrice(priceCell);
  if (priceCell !== undefined && priceCents === null) {
    warnings.push({
      code: 'price_invalid',
      message: `${label}: the price ${quote(priceCell)} can’t be read, so the service’s price is used.`,
    });
  }
  const text = (indexes: number[]) => {
    const [value] = values(indexes);
    return value === undefined ? null : value.slice(0, MAX_VALUE);
  };
  if (reasons.length > before || date === null) return null;
  const [statusCell] = values(columns.status);
  return {
    date,
    time,
    end,
    duration,
    service: text(columns.service),
    staff: text(columns.staff),
    priceCents,
    status: statusCell === undefined ? 'kept' : readStatus(statusCell),
    visitId: text(columns.visitId),
  };
}

/** What is wrong with a phone, and how to fix it. */
function phoneProblem(value: string): string {
  const digits = value.replace(/\D/g, '').length;
  if (!value.trim().startsWith('+') && /^[\d\s().-]+$/.test(value) && digits < 10) {
    return `the phone ${quote(value)} has ${String(digits)} digits; a US number needs 10, with the area code.`;
  }
  return `${quote(value)} isn’t a phone number. Use 10 digits, or + and the country code.`;
}

function rowHash(...values: (string | null)[]): string {
  const normal = values.map((value, i) => (i === 0 ? (value?.toLowerCase() ?? null) : value));
  return createHash('sha256').update(JSON.stringify(normal)).digest('hex');
}

/** A client of the business as matching sees them. */
export interface KnownClient {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tags: readonly string[];
  birthday: ClientBirthday | null;
}

/** The business's clients a file can match, loaded by the service for the file's rows. */
export interface MatchIndex {
  /** Clients by the other tool's id (in this import's system). */
  byExternalId: ReadonlyMap<string, KnownClient>;
  byEmail: ReadonlyMap<string, KnownClient>;
  /** Clients by phone; several people may share one (a family). */
  byPhone: ReadonlyMap<string, readonly KnownClient[]>;
  /** Clients an identical row of an earlier import (not undone) created or matched. */
  byHash: ReadonlyMap<string, KnownClient>;
}

/** What one row does. */
export interface PlannedRow {
  row: number;
  outcome: ImportRowOutcome;
  reasons: ImportReason[];
  /** The existing client it matches; `null` for a new or skipped one. */
  clientId: string | null;
  /** The empty fields a merge fills, and the tags it adds. */
  fills: { email?: string; phone?: string; birthday?: ClientBirthday; tags?: string[] };
  /**
   * A row skipped as the same client as an earlier one: that row (whose client it is), or the
   * client an earlier chunk of the run created or matched. A visits file uses it (S49): several
   * visits of one client are one client.
   */
  sameAs?: { position: number } | { clientId: string };
}

/** A client the plan may match: an existing one, or one an earlier row of the file creates. */
type Candidate = KnownClient | { planned: number };

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const keyOf = (candidate: Candidate) =>
  'planned' in candidate ? `row:${String(candidate.planned)}` : candidate.id;

/**
 * Plans every row in file order (AC-W1-3, D-3). A row matches the client with the same
 * external id, else the same email, else the one client with the same phone and name; else an
 * identical row of an earlier import. A match fills only the client's empty email and phone;
 * an email another client has is left out (with a reason). A row matching a client an earlier
 * row of the file already created or matched is skipped as a duplicate, as is one whose phone
 * and name several clients share.
 */
export function planRows(
  format: ImportFormat,
  rows: readonly MappedRow[],
  index: MatchIndex,
  options: {
    /**
     * Clients earlier chunks of the same run already created or matched, with the file row
     * that did: a row reaching one is a duplicate, as in the preview.
     */
    claimed?: ReadonlyMap<string, number>;
  } = {},
): PlannedRow[] {
  const claimedRows = options.claimed ?? new Map<string, number>();
  // The index grows with what earlier rows of the file create or fill.
  const byExternalId = new Map<string, Candidate>(index.byExternalId);
  const byEmail = new Map<string, Candidate>(index.byEmail);
  const byPhone = new Map<string, Candidate[]>(
    [...index.byPhone].map(([phone, list]) => [phone, [...list]]),
  );
  const byHash = new Map<string, Candidate>(index.byHash);
  /** Which row of the file created or matched a candidate. */
  const claimedBy = new Map<string, number>();
  const nameOf = (candidate: Candidate) =>
    'planned' in candidate ? (rows[candidate.planned]?.name ?? '') : candidate.name;

  const remember = (row: MappedRow, candidate: Candidate) => {
    if (row.externalId !== null && !byExternalId.has(row.externalId)) {
      byExternalId.set(row.externalId, candidate);
    }
    if (row.email !== null && !byEmail.has(row.email)) byEmail.set(row.email, candidate);
    if (row.phone !== null) {
      const list = byPhone.get(row.phone) ?? [];
      const at = list.findIndex((other) => keyOf(other) === keyOf(candidate));
      if (at === -1) list.push(candidate);
      else list[at] = candidate;
      byPhone.set(row.phone, list);
    }
    if (!byHash.has(row.hash)) byHash.set(row.hash, candidate);
  };

  return rows.map((row, position): PlannedRow => {
    const base = {
      row: row.row,
      reasons: [...row.reasons, ...row.warnings],
      clientId: null,
      fills: {},
    };
    if (!row.valid || row.name === null) return { ...base, outcome: 'invalid' };
    const label = rowLabel(format, row.row);
    const rowName = row.name;
    const skip = (reason: ImportReason): PlannedRow => ({
      ...base,
      outcome: 'skipped',
      reasons: [reason],
    });

    let match: Candidate | undefined =
      (row.externalId === null ? undefined : byExternalId.get(row.externalId)) ??
      (row.email === null ? undefined : byEmail.get(row.email));
    if (match === undefined && row.phone !== null) {
      const same = (byPhone.get(row.phone) ?? []).filter((c) => sameName(nameOf(c), rowName));
      if (same.length > 1) {
        return skip({
          code: 'phone_shared',
          message: `${label}: ${String(same.length)} clients named ${rowName} share this phone. Add an email to tell them apart.`,
        });
      }
      match = same[0];
    }
    match ??= byHash.get(row.hash);

    if (match === undefined) {
      const created: Candidate = { planned: position };
      claimedBy.set(keyOf(created), position);
      remember(row, created);
      return { ...base, outcome: 'create' };
    }
    const earlier = claimedBy.get(keyOf(match));
    const earlierRow = 'planned' in match ? undefined : claimedRows.get(match.id);
    if (earlier !== undefined || earlierRow !== undefined || 'planned' in match) {
      const first = earlierRow ?? rows[earlier ?? 0]?.row ?? 0;
      return {
        ...skip({
          code: 'duplicate_in_file',
          message: `${label}: the same client as ${rowLabel(format, first).toLowerCase()}, so it’s skipped.`,
        }),
        sameAs: 'planned' in match ? { position: match.planned } : { clientId: match.id },
      };
    }

    const client = match;
    claimedBy.set(client.id, position);
    const fills: PlannedRow['fills'] = {};
    const reasons: ImportReason[] = [];
    if (client.email === null && row.email !== null) {
      if (byEmail.has(row.email)) {
        reasons.push({
          code: 'email_taken',
          message: `${label}: another client already has ${quote(row.email)}, so it’s left out.`,
        });
      } else {
        fills.email = row.email;
      }
    }
    if (client.phone === null && row.phone !== null) fills.phone = row.phone;
    if (client.birthday === null && row.birthday !== null) fills.birthday = row.birthday;
    const have = new Set(client.tags.map((tag) => tag.toLowerCase()));
    const tags = row.tags.filter((tag) => !have.has(tag.toLowerCase()));
    if (tags.length > 0) fills.tags = tags;
    const merged: KnownClient = {
      ...client,
      email: fills.email ?? client.email,
      phone: fills.phone ?? client.phone,
      birthday: fills.birthday ?? client.birthday,
      tags: [...client.tags, ...tags],
    };
    // Entries pointing at the client as it was may stay: a later row reaching the client by
    // any of them is a duplicate of this one.
    remember(row, merged);
    const outcome = Object.keys(fills).length > 0 ? 'merge' : 'unchanged';
    return { ...base, outcome, reasons: [...base.reasons, ...reasons], clientId: client.id, fills };
  });
}
