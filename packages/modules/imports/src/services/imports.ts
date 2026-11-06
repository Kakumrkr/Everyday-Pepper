import {
  ImportBatchIdSchema,
  ImportBatchSchema,
  ImportColumnSchema,
  ImportCountsSchema,
  ImportMappingInputSchema,
  ImportReasonSchema,
  ImportUndoSchema,
  ImportVisitSchema,
  ClientBirthdaySchema,
  IMPORT_PREVIEW_ROWS,
  IMPORT_UNDO_DAYS,
  type ImportBatch,
  type ImportBatchId,
  type ImportColumn,
  type ImportCounts,
  type ImportFormat,
  type ImportKind,
  type ImportPreset,
  type ImportMapping,
  type ImportMappingAnswer,
  type ImportMappingQuestion,
  type ImportReason,
  type ImportVisit,
  type ImportMappingInput,
  type ImportPreview,
  type ImportRow,
  type ImportRowOutcome,
  type TenantId,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, systemClock, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  claimImportBatch,
  deleteImportBatch,
  fillClientContact,
  findImportBatch,
  findClientsByEmails,
  findClientsByImportHashes,
  findClientsByImportRefs,
  findClientsByOwnIds,
  findClientsByPhones,
  insertImportBatch,
  insertImportedClients,
  insertImportRefs,
  listImportBatches,
  listImportHousekeeping,
  listImportPreviewRows,
  listClaimedImportClients,
  listImportRows,
  listPendingImportRows,
  lockImportBatch,
  lockTenantImports,
  markImportRowsApplied,
  newId,
  purgeImportRows,
  replaceImportRows,
  undoImportBatchRows,
  updateImportBatch,
  withMember,
  withTenant,
  type AppliedImportRow,
  type Database,
  type ImportBatchRow,
  type ImportRowRow,
  type ImportRowValues,
  type MatchClient,
  type TenantTx,
} from '@pepper/db';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ImportMappingInvalidError,
  ImportNotFoundError,
  ImportNotReadyError,
  ImportNotStagedError,
  ImportNotUndoableError,
} from '../errors.js';
import { kindOf, mappingOf, mappingProblems, normalizeHeader, suggestMapping } from '../mapping.js';
import { acceptSuggestions, mappingQuestion } from '../suggestions.js';
import { parseImportFile, type Table } from '../parse.js';
import {
  mapRows,
  planRows,
  rowLabel,
  type KnownClient,
  type MappedRow,
  type MatchIndex,
  type PlannedRow,
} from '../rows.js';
import {
  planVisits,
  serviceKey,
  visitTimes,
  type NewVisit,
  type PlannedVisit,
  type VisitBook,
  type VisitEntry,
  type VisitService,
} from '../visits.js';

// Client import (S48, ADR-0049, AC-W1-3, AC-W1-17…19). An owner or manager (`clients.manage`)
// stages a file: it is parsed, mapped and planned against the business's clients, and its
// rows are kept, with nothing written to the clients. They may change the mapping (the plan
// follows), discard it, or commit it: the worker's `imports` queue then runs it in chunks,
// planning each chunk again against the clients as they are by then, and it can be undone
// for IMPORT_UNDO_DAYS. Client details never reach the audit log or the logs.
//
// A visits file (S49, ADR-0050) goes the same way: its rows find or create their clients as a
// client file's do, then become past visits or upcoming appointments through the `VisitBook`
// the appointments module serves (passed in by the api and the worker), with no email.

/** The `system` of Pepper's own export: its preset's name (S51, ADR-0053). */
const PEPPER_SYSTEM: ImportPreset = 'pepper';

/** Rows a run writes per transaction (each extends the lease). */
export const IMPORT_RUN_CHUNK = 500;
/** How long a run holds its batch before another worker may take it over. */
export const IMPORT_LEASE_MS = 5 * 60_000;
/** Runs a batch gets before it is marked failed (what it wrote stays, and can be undone). */
export const IMPORT_MAX_ATTEMPTS = 3;
/** How long a staged import waits for its commit before it is discarded. */
export const STAGED_IMPORT_TTL_MS = 24 * 60 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const ColumnsSchema = z.array(ImportColumnSchema);
const ProblemsSchema = z.array(z.string());
const CellsSchema = z.array(z.string());
const ReasonsSchema = z.array(ImportReasonSchema);

const EMPTY_COUNTS: ImportCounts = {
  rows: 0,
  create: 0,
  merge: 0,
  unchanged: 0,
  invalid: 0,
  skipped: 0,
  conflict: 0,
  clients: 0,
  past: 0,
  upcoming: 0,
};

/** What an import's services need beyond the database (S49). */
export interface ImportOptions {
  /** "Now" for a visits file: what is past and what is upcoming. */
  clock?: Clock;
  /** The appointments module's port, for a visits file (ADR-0050 §2). */
  visits?: VisitBook;
}

function visitBookOf(options: ImportOptions): VisitBook {
  if (options.visits === undefined) throw new Error('A visits file needs the VisitBook');
  return options.visits;
}

/** Imports the business's clients from a file it uploaded: the staged preview (AC-W1-17/18). */
export async function stageImport(
  db: Database,
  actor: Actor,
  bytes: Uint8Array,
  options: { format?: ImportFormat | undefined } & ImportOptions = {},
): Promise<ImportPreview> {
  requirePermission(actor, 'clients.manage');
  // Before any transaction: a file that can't be read is refused with its reason.
  const table = parseImportFile(bytes, options.format);
  const { preset, columns } = suggestMapping(table);
  const mapping = mappingOf(columns);
  const kind = kindOf(mapping);
  return withMember(db, actor.context, async (tx) => {
    const batch = await insertImportBatch(tx, {
      createdByUserId: actor.context.userId,
      kind,
      format: table.format,
      preset,
      system: preset ?? fileSystem(table.columns),
      columns,
      problems: mappingProblems(mapping),
      counts: EMPTY_COUNTS,
    });
    const id = ImportBatchIdSchema.parse(batch.id);
    const planned = await planAndStore(tx, batch, id, table, mapping, options);
    const updated = await updateImportBatch(tx, id, {
      counts: planned.counts,
      notices: planned.notices,
      problems: [...mappingProblems(mapping), ...planned.problems],
    });
    return previewOf(tx, updated ?? batch);
  });
}

/** Another file's external ids are its own: `file:` and a digest of its column names. */
function fileSystem(columns: readonly string[]): string {
  const names = columns.map(normalizeHeader).sort().join('\n');
  return `file:${createHash('sha256').update(names).digest('hex').slice(0, 16)}`;
}

/** The import with its preview rows. */
export async function getImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
): Promise<ImportPreview> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  return withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, false);
    return previewOf(tx, batch);
  });
}

/** The business's latest imports, newest first (the screen's "Undo" lives on them). */
export async function listImports(db: Database, actor: Actor): Promise<ImportBatch[]> {
  requirePermission(actor, 'clients.manage');
  const rows = await withMember(db, actor.context, (tx) => listImportBatches(tx, 10));
  return rows.map(toBatch);
}

/** Changes a staged import's mapping; the preview follows (AC-W1-17). */
export async function remapImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
  input: ImportMappingInput,
  options: ImportOptions = {},
): Promise<ImportPreview> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  const { columns: wanted } = ImportMappingInputSchema.parse(input);
  return withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, true);
    if (batch.status !== 'staged') throw new ImportNotStagedError();
    const before = ColumnsSchema.parse(batch.columns);
    const known = new Set(before.map(({ column }) => column));
    const unknown = wanted.find(({ column }) => !known.has(column));
    if (unknown !== undefined) {
      throw new ImportMappingInvalidError(`The file has no column “${unknown.column}”.`);
    }
    const chosen = new Map(wanted.map(({ column, field }) => [column, field]));
    const columns: ImportColumn[] = before.map((column) => {
      const field = chosen.has(column.column) ? (chosen.get(column.column) ?? null) : null;
      if (field === column.field) return column;
      // The owner decided, either way: a column they left out isn't asked about again.
      return { ...column, field, by: 'owner' };
    });
    const mapping = mappingOf(columns);
    const table = await tableOf(tx, batch, before);
    const planned = await planAndStore(tx, batch, id, table, mapping, options);
    const updated = await updateImportBatch(tx, id, {
      kind: kindOf(mapping),
      columns,
      problems: [...mappingProblems(mapping), ...planned.problems],
      notices: planned.notices,
      counts: planned.counts,
    });
    return previewOf(tx, updated ?? batch);
  });
}

/**
 * What the AI may be asked about a staged import (S56a.2, ADR-0061, AC-W1-46): the columns
 * nothing placed and the owner hasn't decided, by name, with masked samples; `null` when there
 * is nothing to ask (every column placed, decided or asked already).
 */
export async function importMappingQuestion(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
): Promise<ImportMappingQuestion | null> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  return withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, false);
    if (batch.status !== 'staged') throw new ImportNotStagedError();
    const columns = ColumnsSchema.parse(batch.columns);
    const table = await tableOf(tx, batch, columns);
    return mappingQuestion(table, columns, batch.kind as ImportKind);
  });
}

/**
 * Stores the AI's answer as suggestions, checked against the columns as they are now
 * (AC-W1-47): the mapping, the plan and the counts don't change until the owner uses one.
 */
export async function saveImportSuggestions(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
  question: ImportMappingQuestion,
  answer: ImportMappingAnswer,
): Promise<ImportPreview> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  return withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, true);
    if (batch.status !== 'staged') throw new ImportNotStagedError();
    const columns = acceptSuggestions(ColumnsSchema.parse(batch.columns), question, answer);
    const updated = await updateImportBatch(tx, id, { columns });
    return previewOf(tx, updated ?? batch);
  });
}

/** Discards a staged import (nothing was written). */
export async function discardImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
): Promise<void> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  await withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, true);
    if (batch.status !== 'staged') throw new ImportNotStagedError();
    await deleteImportBatch(tx, id);
  });
}

/** Commits a staged import: the worker runs it next (AC-W1-3). */
export async function commitImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
  clock: Clock,
): Promise<ImportBatch> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  return withMember(db, actor.context, async (tx) => {
    const batch = await findOrThrow(tx, id, true);
    if (batch.status !== 'staged') throw new ImportNotStagedError();
    const [problem] = ProblemsSchema.parse(batch.problems);
    if (problem !== undefined) throw new ImportNotReadyError(problem);
    const counts = ImportCountsSchema.parse(batch.counts);
    // A visits file's rows count by their visit; a client detail it fills is something too.
    const fillsClients =
      batch.kind === 'visits' &&
      (await listImportRows(tx, id)).some((row) => Object.keys(row.fills as object).length > 0);
    if (counts.create + counts.merge === 0 && !fillsClients) {
      throw new ImportNotReadyError(
        batch.kind === 'visits'
          ? 'There’s nothing to import: every visit is invalid, skipped, taken or already in Pepper.'
          : 'There’s nothing to import: every row is invalid, skipped or already a client.',
      );
    }
    const now = clock.now();
    const updated = await updateImportBatch(tx, id, {
      status: 'queued',
      committedAt: now,
      availableAt: now,
    });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client_import.committed',
        entity: { type: 'client_import', id },
        before: null,
        after: { rows: counts.rows },
      },
      requestId: actor.requestId,
    });
    return toBatch(updated ?? batch);
  });
}

/**
 * Undoes a finished import within IMPORT_UNDO_DAYS (AC-W1-19, AC-W1-25): a visits file's
 * bookings go unless changed since, then its new clients unless they have a booking or
 * waitlist entry since; the emails, phones, birthdays and tags it filled are cleared where
 * unchanged, and its rows' client details are cleared (D-5).
 */
export async function undoImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
  clock: Clock,
  options: ImportOptions = {},
): Promise<ImportBatch> {
  requirePermission(actor, 'clients.manage');
  const id = ImportBatchIdSchema.parse(batchId);
  return withMember(db, actor.context, async (tx) => {
    await lockTenantImports(tx);
    const batch = await findOrThrow(tx, id, true);
    const now = clock.now();
    if (batch.status === 'undone') throw new ImportNotUndoableError('It’s already undone.');
    if (batch.status !== 'done' && batch.status !== 'failed') {
      throw new ImportNotUndoableError('It hasn’t finished yet.');
    }
    if (batch.undoUntil === null || now > batch.undoUntil) {
      throw new ImportNotUndoableError(
        `An import can be undone for ${String(IMPORT_UNDO_DAYS)} days, and this one’s are over.`,
      );
    }
    const bookings =
      batch.kind === 'visits' ? await visitBookOf(options).undo(tx, id) : { deleted: 0, kept: 0 };
    // The insights forget the history that went (as a run made them see it).
    if (bookings.deleted > 0) await visitBookOf(options).finished(tx);
    const undo = {
      ...(await undoImportBatchRows(tx, id)),
      bookings: bookings.deleted,
      bookingsKept: bookings.kept,
    };
    await purgeImportRows(tx, id);
    const updated = await updateImportBatch(tx, id, {
      status: 'undone',
      undoneAt: now,
      undo,
      purgedAt: now,
    });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client_import.undone',
        entity: { type: 'client_import', id },
        before: null,
        after: undo,
      },
      requestId: actor.requestId,
    });
    return toBatch(updated ?? batch);
  });
}

// The worker --------------------------------------------------------------------------------

export interface ImportJob {
  batchId: ImportBatchId;
  tenantId: TenantId;
}

export type ImportRunResult = 'done' | 'failed' | 'not_due';

/**
 * Runs a committed import (the worker's `imports` job): claims it for a lease, then applies
 * its rows in chunks, each planned again against the clients as they are and written in one
 * transaction with the rows it applied, so a run cut short continues where it stopped.
 * Idempotent: applied rows are not applied again. After IMPORT_MAX_ATTEMPTS it is `failed`.
 */
export async function runImport(
  db: Database,
  job: ImportJob,
  clock: Clock,
  options: ImportOptions = {},
): Promise<ImportRunResult> {
  const id = ImportBatchIdSchema.parse(job.batchId);
  const lease = () => new Date(clock.now().getTime() + IMPORT_LEASE_MS);
  const claimed = await withTenant(db, job.tenantId, (tx) =>
    claimImportBatch(tx, id, clock.now(), lease()),
  );
  if (claimed === undefined) return 'not_due';
  if (claimed.attempts > IMPORT_MAX_ATTEMPTS) {
    await withTenant(db, job.tenantId, (tx) => finish(tx, claimed, 'failed', clock, options));
    return 'failed';
  }
  for (;;) {
    const more = await withTenant(db, job.tenantId, async (tx) => {
      await lockTenantImports(tx);
      const batch = await lockImportBatch(tx, id);
      // Another worker took it over and finished or gave it up: that one reports it.
      if (batch?.status !== 'running') return 'not_due';
      const pending = await listPendingImportRows(tx, id, IMPORT_RUN_CHUNK);
      if (pending.length === 0) {
        await finish(tx, batch, 'done', clock, options);
        return 'done';
      }
      await applyChunk(tx, batch, pending, clock.now(), options);
      await updateImportBatch(tx, id, { leaseUntil: lease() });
      return 'more';
    });
    if (more !== 'more') return more;
  }
}

async function applyChunk(
  tx: TenantTx,
  batch: ImportBatchRow,
  rows: readonly ImportRowRow[],
  now: Date,
  options: ImportOptions,
): Promise<void> {
  const id = ImportBatchIdSchema.parse(batch.id);
  const format = batch.format as ImportFormat;
  // The rows again under the batch's mapping (as staged: the same cells, the same mapping).
  const columns = ColumnsSchema.parse(batch.columns);
  const mapped = mapRows(
    {
      format,
      columns: columns.map(({ column }) => column),
      rows: rows.map((row) => ({ row: row.row, cells: CellsSchema.parse(row.cells ?? []) })),
    },
    mappingOf(columns),
  );
  const claimed = new Map(
    (await listClaimedImportClients(tx, id)).map(({ clientId, row }) => [clientId, row]),
  );
  const plan = planRows(format, mapped, await matchIndex(tx, mapped, batch.system), { claimed });
  const created = plan.flatMap((planned, i) =>
    planned.outcome === 'create' ? [{ i, id: newId() }] : [],
  );
  const createdIds = new Map(created.map(({ i, id: clientId }) => [i, clientId]));
  await insertImportedClients(
    tx,
    created.map(({ i, id: clientId }) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
      const row = mapped[i]!;
      return {
        id: clientId,
        name: row.name ?? '',
        email: row.email,
        phone: row.phone,
        tags: row.tags,
        birthday: row.birthday,
      };
    }),
  );
  const fills = new Map<number, PlannedRow['fills']>();
  for (const [i, planned] of plan.entries()) {
    if (planned.outcome !== 'merge' || planned.clientId === null) continue;
    // Only what is still empty is filled (someone may have added it since the plan).
    fills.set(i, await fillClientContact(tx, planned.clientId, planned.fills));
  }
  const clientOf = (i: number): string | null => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const planned = plan[i]!;
    const own = createdIds.get(i) ?? planned.clientId;
    if (own !== null) return own;
    if (planned.sameAs === undefined) return null;
    return 'clientId' in planned.sameAs
      ? planned.sameAs.clientId
      : clientOf(planned.sameAs.position);
  };

  const visits =
    batch.kind === 'visits'
      ? await applyVisits(tx, batch, mapped, plan, clientOf, now, options)
      : new Map<number, AppliedVisit>();

  const applied: AppliedImportRow[] = [];
  const refs: { externalId: string; clientId: string }[] = [];
  for (const [i, planned] of plan.entries()) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const row = rows[i]!;
    // A repeat of an earlier row's client records that client, so a re-import finds the row
    // again by its identity even when its own contact has become ambiguous (S49's CI).
    const clientId = clientOf(i);
    const filled = fills.get(i) ?? {};
    const visit = visits.get(i);
    let outcome: ImportRowOutcome = planned.outcome;
    if (planned.outcome === 'merge' && Object.keys(filled).length === 0) outcome = 'unchanged';
    if (visit !== undefined) outcome = visit.outcome;
    if (clientId !== null && row.externalId !== null) {
      refs.push({ externalId: row.externalId, clientId });
    }
    applied.push({
      position: row.position,
      outcome,
      reasons:
        visit === undefined ? planned.reasons : [...clientReasons(planned), ...visit.reasons],
      clientId,
      fills: filled,
      createdClient: createdIds.has(i),
      bookingId: visit?.bookingId ?? null,
      visit: visit?.display ?? null,
    });
  }
  await insertImportRefs(tx, id, batch.system, refs);
  await markImportRowsApplied(tx, id, applied, now);
}

interface AppliedVisit {
  outcome: ImportRowOutcome;
  reasons: ImportReason[];
  bookingId: string | null;
  display: ImportVisit | null;
}

/** Plans and writes a chunk's visits, once their clients are in (ADR-0050). */
async function applyVisits(
  tx: TenantTx,
  batch: ImportBatchRow,
  mapped: readonly MappedRow[],
  plan: readonly PlannedRow[],
  clientOf: (i: number) => string | null,
  now: Date,
  options: ImportOptions,
): Promise<Map<number, AppliedVisit>> {
  const book = visitBookOf(options);
  const id = ImportBatchIdSchema.parse(batch.id);
  const entries: { i: number; entry: VisitEntry }[] = [];
  for (const [i, row] of mapped.entries()) {
    const clientId = clientOf(i);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const planned = plan[i]!;
    if (row.visit === null || clientId === null || planned.outcome === 'invalid') continue;
    entries.push({ i, entry: { row: row.row, visit: row.visit, clientKey: clientId } });
  }
  const out = new Map<number, AppliedVisit>();
  if (entries.length === 0) return out;
  const { visits, summary } = await planWith(
    tx,
    book,
    batch.createdByUserId,
    entries,
    now.getTime(),
    batch.format as ImportFormat,
  );
  // Hidden services for names the business doesn't have, made once (or found if made since),
  // with the most common length of their rows, as the preview said.
  const hidden = new Map<string, VisitService>();
  if (summary.newServices.length > 0) {
    const wanted = summary.newServices.map(({ name, durationMinutes }) => ({
      name,
      durationMinutes,
    }));
    for (const service of await book.addHiddenServices(tx, wanted)) {
      hidden.set(serviceKey(service.name), service);
    }
  }
  const writes: { i: number; k: number; visit: NewVisit }[] = [];
  for (const [k, { i }] of entries.entries()) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one plan per entry
    const visit = visits[k]!;
    const service = visit.serviceId === null ? hidden.get(visit.serviceKey) : undefined;
    const serviceId = visit.serviceId ?? service?.id ?? null;
    const clientId = clientOf(i);
    if (visit.outcome !== 'create') {
      out.set(i, {
        outcome: visit.outcome,
        reasons: visit.reasons,
        bookingId: null,
        display: displayOf(visit, null),
      });
      continue;
    }
    if (visit.staffId === null) {
      // Nobody on the team can take it (the default staff member left since the preview).
      out.set(i, {
        outcome: 'invalid',
        reasons: [
          {
            code: 'no_staff',
            message: `${rowLabelOf(batch, visit.row)}: nobody on your team can take this visit. Add yourself to your team, then import the file again.`,
          },
        ],
        bookingId: null,
        display: displayOf(visit, null),
      });
      continue;
    }
    if (serviceId === null || clientId === null) {
      throw new Error('A planned visit has no service or client');
    }
    writes.push({
      i,
      k,
      visit: {
        id: newId(),
        clientId,
        serviceId,
        staffMemberId: visit.staffId,
        startsAt: new Date(visit.startsAt),
        endsAt: new Date(visit.startsAt + visit.durationMinutes * 60_000),
        bufferBeforeMinutes: service?.bufferBeforeMinutes ?? visit.bufferBeforeMinutes,
        bufferAfterMinutes: service?.bufferAfterMinutes ?? visit.bufferAfterMinutes,
        priceFromCents: visit.priceCents,
        status: visit.status,
        createdBy: batch.createdByUserId,
      },
    });
  }
  const { conflicts } = await book.writeVisits(
    tx,
    id,
    writes.map(({ visit }) => visit),
  );
  const lost = new Set(conflicts);
  for (const { i, k, visit } of writes) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one plan per entry
    const planned = visits[k]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per entry
    const label = mapped[i]!.row;
    out.set(
      i,
      lost.has(visit.id)
        ? {
            outcome: 'conflict' as const,
            reasons: [
              {
                code: 'conflict',
                message: `${rowLabelOf(batch, label)}: ${planned.staffName} was booked at that time meanwhile, so this one is left out.`,
              },
            ],
            bookingId: null,
            display: displayOf(planned, null),
          }
        : {
            outcome: 'create',
            reasons: [],
            bookingId: visit.id,
            display: displayOf(planned, visit.id),
          },
    );
  }
  return out;
}

async function finish(
  tx: TenantTx,
  batch: ImportBatchRow,
  status: 'done' | 'failed',
  clock: Clock,
  options: ImportOptions,
): Promise<void> {
  const id = ImportBatchIdSchema.parse(batch.id);
  const now = clock.now();
  const rows = await listImportRows(tx, id);
  // What was written: a failed run's rows it never reached count for nothing.
  const counts = {
    ...countRows(rows.filter((row) => row.appliedAt !== null)),
    rows: rows.length,
  };
  // New bookings: the insights see them once, not once per visit (ADR-0050 §7).
  if (batch.kind === 'visits' && counts.create > 0) await visitBookOf(options).finished(tx);
  await updateImportBatch(tx, id, {
    status,
    counts,
    finishedAt: now,
    undoUntil: new Date(now.getTime() + IMPORT_UNDO_DAYS * DAY_MS),
    leaseUntil: null,
  });
  const { create, merge, unchanged, invalid, skipped, conflict, clients, past, upcoming } = counts;
  const tally = { create, merge, unchanged, invalid, skipped, conflict, clients, past, upcoming };
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'client_import.finished',
      entity: { type: 'client_import', id },
      before: null,
      after: { ...tally, status },
    },
  });
}

/**
 * Tidies imports (D-5): discards staged ones left uncommitted for STAGED_IMPORT_TTL_MS, and
 * clears the client details of finished ones whose undo window is over. Returns how many.
 */
export async function tidyImports(db: Database, clock: Clock, limit = 100): Promise<number> {
  const now = clock.now();
  const due = await listImportHousekeeping(
    db,
    now,
    new Date(now.getTime() - STAGED_IMPORT_TTL_MS),
    limit,
  );
  for (const { batchId, tenantId, action } of due) {
    await withTenant(db, tenantId, async (tx) => {
      const batch = await lockImportBatch(tx, batchId);
      if (batch === undefined) return;
      if (action === 'discard' && batch.status === 'staged') await deleteImportBatch(tx, batchId);
      if (action === 'purge' && batch.purgedAt === null) {
        await purgeImportRows(tx, batchId);
        await updateImportBatch(tx, batchId, { purgedAt: now });
      }
    });
  }
  return due.length;
}

// Planning ----------------------------------------------------------------------------------

/**
 * Plans the table under `mapping` and stores its rows; returns the preview's counts, notices and
 * problems. A visits file's rows are planned as clients first, then as visits (ADR-0050).
 */
async function planAndStore(
  tx: TenantTx,
  batch: ImportBatchRow,
  id: ImportBatchId,
  table: Table,
  mapping: ImportMapping,
  options: ImportOptions,
): Promise<{ counts: ImportCounts; notices: string[]; problems: string[] }> {
  const mapped = mapRows(table, mapping);
  const plan = planRows(table.format, mapped, await matchIndex(tx, mapped, batch.system));
  const keyOf = (i: number): string | null => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const planned = plan[i]!;
    if (planned.outcome === 'create') return `row:${String(i)}`;
    if (planned.clientId !== null) return planned.clientId;
    if (planned.sameAs === undefined) return null;
    return 'clientId' in planned.sameAs ? planned.sameAs.clientId : keyOf(planned.sameAs.position);
  };
  const visits = new Map<number, PlannedVisit>();
  let notices: string[] = [];
  let problems: string[] = [];
  if (kindOf(mapping) === 'visits') {
    const entries: { i: number; entry: VisitEntry }[] = [];
    for (const [i, row] of mapped.entries()) {
      const key = keyOf(i);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
      if (row.visit === null || key === null || plan[i]!.outcome === 'invalid') continue;
      entries.push({ i, entry: { row: row.row, visit: row.visit, clientKey: key } });
    }
    if (entries.length > 0) {
      const now = (options.clock ?? systemClock).now().getTime();
      const planned = await planWith(
        tx,
        visitBookOf(options),
        batch.createdByUserId,
        entries,
        now,
        table.format,
      );
      for (const [k, { i }] of entries.entries()) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one plan per entry
        visits.set(i, planned.visits[k]!);
      }
      ({ notices, problems } = planned.summary);
    }
  }
  const rows: (ImportRowValues & { createdClient: boolean })[] = plan.map((planned, position) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const row = mapped[position]!;
    const visit = visits.get(position);
    const visitRow = kindOf(mapping) === 'visits';
    // A visits file's row says what its visit does; its client's part is in `fills` and reasons.
    let outcome: ImportRowOutcome = planned.outcome;
    if (visitRow && planned.outcome !== 'invalid') {
      outcome =
        visit?.outcome ??
        (planned.sameAs === undefined && planned.outcome === 'skipped' ? 'skipped' : 'invalid');
    }
    return {
      position,
      row: row.row,
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one table row per mapped row
      cells: table.rows[position]!.cells,
      name: row.name,
      email: row.email,
      phone: row.phone,
      externalId: row.externalId,
      rowHash: row.hash,
      outcome,
      reasons:
        visit === undefined ? planned.reasons : [...clientReasons(planned), ...visit.reasons],
      clientId: planned.clientId,
      fills: planned.fills,
      details: { tags: row.tags, birthday: row.birthday },
      visit: visit === undefined ? null : displayOf(visit, null),
      createdClient: planned.outcome === 'create',
    };
  });
  await replaceImportRows(tx, id, rows);
  return { counts: countRows(rows), notices, problems };
}

/** Loads what a chunk of visits needs through the port, and plans them. */
async function planWith(
  tx: TenantTx,
  book: VisitBook,
  userId: string | null,
  entries: readonly { entry: VisitEntry }[],
  now: number,
  format: ImportFormat,
): Promise<ReturnType<typeof planVisits>> {
  const context = await book.context(tx, userId);
  let first = Infinity;
  let last = -Infinity;
  let firstUpcoming = Infinity;
  for (const { entry } of entries) {
    const times = visitTimes(entry.visit, context.timeZone);
    if (times === null) continue;
    first = Math.min(first, times.start);
    last = Math.max(last, times.start);
    if (times.start >= now) firstUpcoming = Math.min(firstUpcoming, times.start);
  }
  // Busy time around the upcoming visits (a day either side covers lengths and buffers).
  const busy =
    firstUpcoming === Infinity
      ? []
      : await book.busy(tx, new Date(firstUpcoming - DAY_MS), new Date(last + DAY_MS));
  const clientIds = [
    ...new Set(
      entries.map(({ entry }) => entry.clientKey).filter((key) => !key.startsWith('row:')),
    ),
  ];
  const starts =
    first === Infinity || clientIds.length === 0
      ? []
      : await book.visitStarts(tx, clientIds, new Date(first), new Date(last + 1));
  const existing = new Set(
    starts.map(({ clientId, startsAt }) => `${clientId}|${String(startsAt.getTime())}`),
  );
  return planVisits(
    format,
    entries.map(({ entry }) => entry),
    context,
    { now, busy, existing },
  );
}

/** The staged file again, from its rows' cells. */
async function tableOf(
  tx: TenantTx,
  batch: ImportBatchRow,
  columns: readonly ImportColumn[],
): Promise<Table> {
  const rows = await listImportRows(tx, ImportBatchIdSchema.parse(batch.id));
  return {
    format: batch.format as ImportFormat,
    columns: columns.map(({ column }) => column),
    rows: rows.map((row) => ({ row: row.row, cells: CellsSchema.parse(row.cells) })),
  };
}

/** The business's clients these rows can match. */
async function matchIndex(
  tx: TenantTx,
  rows: readonly MappedRow[],
  system: string,
): Promise<MatchIndex> {
  const valid = rows.filter((row) => row.valid);
  const unique = (values: (string | null)[]) => [
    ...new Set(values.filter((v): v is string => v !== null)),
  ];
  // One after another: a transaction's queries share one connection.
  const externalIds = unique(valid.map((r) => r.externalId));
  const byRef = await findClientsByImportRefs(tx, system, externalIds);
  // Pepper's own export carries the business's client ids (S51, ADR-0053): a re-import into
  // the same business finds them; into another one, the refs its first import kept.
  const byOwnId = system === PEPPER_SYSTEM ? await findClientsByOwnIds(tx, externalIds) : [];
  const byEmail = await findClientsByEmails(tx, unique(valid.map((r) => r.email)));
  const byPhone = await findClientsByPhones(tx, unique(valid.map((r) => r.phone)));
  const byHash = await findClientsByImportHashes(tx, unique(valid.map((r) => r.hash)));
  const phones = new Map<string, KnownClient[]>();
  for (const client of byPhone) {
    // `findClientsByPhones` only returns clients with one of the phones.
    const phone = client.phone ?? '';
    phones.set(phone, [...(phones.get(phone) ?? []), known(client)]);
  }
  return {
    byExternalId: new Map(
      [...byOwnId, ...byRef].map((client) => [client.externalId, known(client)]),
    ),
    byEmail: new Map(byEmail.map((client) => [client.email ?? '', known(client)])),
    byPhone: phones,
    byHash: new Map(byHash.map((client) => [client.rowHash, known(client)])),
  };
}

const known = (client: MatchClient): KnownClient => ({
  id: client.id,
  name: client.name,
  email: client.email,
  phone: client.phone,
  tags: client.tags,
  birthday:
    client.birthdayMonth === null || client.birthdayDay === null
      ? null
      : { month: client.birthdayMonth, day: client.birthdayDay, year: client.birthdayYear },
});

function countRows(
  rows: readonly { outcome: string; createdClient: boolean; visit?: unknown }[],
): ImportCounts {
  const counts = { ...EMPTY_COUNTS, rows: rows.length };
  for (const { outcome, createdClient, visit } of rows) {
    counts[outcome as ImportRowOutcome] += 1;
    if (createdClient) counts.clients += 1;
    if (outcome === 'create' && visit !== null && visit !== undefined) {
      const { status } = ImportVisitSchema.parse(visit);
      if (status === 'confirmed') counts.upcoming += 1;
      else counts.past += 1;
    }
  }
  return counts;
}

/** A visit row's client reasons: several visits of one client aren't duplicates. */
function clientReasons(planned: PlannedRow): ImportReason[] {
  return planned.reasons.filter(({ code }) => code !== 'duplicate_in_file');
}

/** A planned visit as the preview shows it. */
function displayOf(visit: PlannedVisit, bookingId: string | null): ImportVisit {
  return ImportVisitSchema.parse({
    startsAt: new Date(visit.startsAt).toISOString(),
    durationMinutes: visit.durationMinutes,
    service: visit.serviceName,
    staff: visit.staffName,
    status: visit.status,
    bookingId,
  });
}

function rowLabelOf(batch: ImportBatchRow, row: number): string {
  return rowLabel(batch.format as ImportFormat, row);
}

// Answers -----------------------------------------------------------------------------------

async function findOrThrow(
  tx: TenantTx,
  id: ImportBatchId,
  lock: boolean,
): Promise<ImportBatchRow> {
  const batch = lock ? await lockImportBatch(tx, id) : await findImportBatch(tx, id);
  if (batch === undefined) throw new ImportNotFoundError();
  return batch;
}

async function previewOf(tx: TenantTx, batch: ImportBatchRow): Promise<ImportPreview> {
  const rows = await listImportPreviewRows(
    tx,
    ImportBatchIdSchema.parse(batch.id),
    IMPORT_PREVIEW_ROWS,
  );
  return { batch: toBatch(batch), rows: rows.map(toRow) };
}

function toRow(row: ImportRowRow): ImportRow {
  return {
    row: row.row,
    name: row.name,
    email: row.email,
    phone: row.phone,
    outcome: row.outcome as ImportRowOutcome,
    reasons: ReasonsSchema.parse(row.reasons),
    clientId: row.clientId as ImportRow['clientId'],
    ...detailsOf(row.details),
    visit:
      row.visit === null
        ? null
        : ImportVisitSchema.parse({ ...(row.visit as object), bookingId: row.bookingId }),
  };
}

const DetailsSchema = z.object({
  tags: z.array(z.string()).default([]),
  birthday: ClientBirthdaySchema.nullable().default(null),
});

/** A row's tags and birthday (cleared with its other client data). */
function detailsOf(details: unknown): { tags: string[]; birthday: ImportRow['birthday'] } {
  const parsed = DetailsSchema.safeParse(details ?? {});
  return parsed.success ? parsed.data : { tags: [], birthday: null };
}

function toBatch(row: ImportBatchRow): ImportBatch {
  return ImportBatchSchema.parse({
    id: row.id,
    status: row.status,
    kind: row.kind,
    format: row.format,
    preset: row.preset,
    columns: row.columns,
    problems: row.problems,
    notices: row.notices,
    counts: row.counts,
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    undoUntil: row.undoUntil?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undo: row.undo === null ? null : ImportUndoSchema.parse(row.undo),
  });
}
