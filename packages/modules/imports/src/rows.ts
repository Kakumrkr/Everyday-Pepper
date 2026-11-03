import {
  ClientEmailSchema,
  normalizePhone,
  PhoneSchema,
  type ImportFormat,
  type ImportMapping,
  type ImportReason,
  type ImportRowOutcome,
} from '@pepper/contracts';
import { createHash } from 'node:crypto';
import type { Table, TableRow } from './parse.js';

// A file's rows as clients (S48, ADR-0049, AC-W1-3, AC-W1-18): each row's name, email, phone
// and external id under a mapping, checked with a reason the owner can act on, then planned
// against the business's clients: create, merge (fill empty fields), unchanged, or skip.
// Pure: the service loads the clients a file can match and applies the plan.

/** The longest external id kept. */
const MAX_EXTERNAL_ID = 200;
const MAX_NAME = 120;

/** A row under the mapping. `valid` rows have a name and only valid emails and phones. */
export interface MappedRow {
  row: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  /** The row's identity for a later re-import (name, email, phone, external id). */
  hash: string;
  valid: boolean;
  reasons: ImportReason[];
}

/** "Row 14" in a spreadsheet, "Item 3" of a JSON list, "Line 7" of a JSONL file. */
export function rowLabel(format: ImportFormat, row: number): string {
  return `${format === 'csv' ? 'Row' : format === 'json' ? 'Item' : 'Line'} ${String(row)}`;
}

/** Shows a value from the file in a sentence, cut short when long. */
function quote(value: string): string {
  return `“${value.length > 40 ? `${value.slice(0, 39)}…` : value}”`;
}

/** Each row of the table under `mapping` (columns the table doesn't have are ignored). */
export function mapRows(table: Table, mapping: ImportMapping): MappedRow[] {
  const index = new Map(table.columns.map((column, i) => [column, i]));
  const of = (field: string) =>
    mapping.flatMap(({ column, field: f }) => {
      const i = index.get(column);
      return f === field && i !== undefined ? [i] : [];
    });
  const columns = {
    name: of('name'),
    first: of('first_name'),
    last: of('last_name'),
    email: of('email'),
    phone: of('phone'),
    externalId: of('external_id'),
  };
  return table.rows.map((row) => mapRow(table.format, row, columns));
}

function mapRow(
  format: ImportFormat,
  { row, cells }: TableRow,
  columns: Record<'name' | 'first' | 'last' | 'email' | 'phone' | 'externalId', number[]>,
): MappedRow {
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

  return {
    row,
    name,
    email,
    phone,
    externalId,
    hash: rowHash(name, email, phone, externalId),
    valid: reasons.length === 0,
    reasons,
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
  /** The empty fields a merge fills. */
  fills: { email?: string; phone?: string };
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
): PlannedRow[] {
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
    const base = { row: row.row, reasons: row.reasons, clientId: null, fills: {} };
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
    if (earlier !== undefined || 'planned' in match) {
      const first = rows[earlier ?? 0]?.row ?? 0;
      return skip({
        code: 'duplicate_in_file',
        message: `${label}: the same client as ${rowLabel(format, first).toLowerCase()}, so it’s skipped.`,
      });
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
    const merged: KnownClient = {
      ...client,
      email: fills.email ?? client.email,
      phone: fills.phone ?? client.phone,
    };
    // Entries pointing at the client as it was may stay: a later row reaching the client by
    // any of them is a duplicate of this one.
    remember(row, merged);
    const outcome = Object.keys(fills).length > 0 ? 'merge' : 'unchanged';
    return { ...base, outcome, reasons, clientId: client.id, fills };
  });
}
