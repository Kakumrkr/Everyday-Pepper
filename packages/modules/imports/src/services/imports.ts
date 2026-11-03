import {
  ImportBatchIdSchema,
  ImportBatchSchema,
  ImportColumnSchema,
  ImportCountsSchema,
  ImportMappingInputSchema,
  ImportReasonSchema,
  ImportUndoSchema,
  IMPORT_PREVIEW_ROWS,
  IMPORT_UNDO_DAYS,
  type ImportBatch,
  type ImportBatchId,
  type ImportColumn,
  type ImportCounts,
  type ImportFormat,
  type ImportMapping,
  type ImportMappingInput,
  type ImportPreview,
  type ImportRow,
  type ImportRowOutcome,
  type TenantId,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  claimImportBatch,
  deleteImportBatch,
  fillClientContact,
  findImportBatch,
  findClientsByEmails,
  findClientsByImportHashes,
  findClientsByImportRefs,
  findClientsByPhones,
  insertImportBatch,
  insertImportedClients,
  insertImportRefs,
  listImportBatches,
  listImportHousekeeping,
  listImportPreviewRows,
  listImportRows,
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
import { mappingOf, mappingProblems, normalizeHeader, suggestMapping } from '../mapping.js';
import { parseImportFile, type Table } from '../parse.js';
import {
  mapRows,
  planRows,
  type KnownClient,
  type MappedRow,
  type MatchIndex,
  type PlannedRow,
} from '../rows.js';

// Client import (S48, ADR-0049, AC-W1-3, AC-W1-17…19). An owner or manager (`clients.manage`)
// stages a file: it is parsed, mapped and planned against the business's clients, and its
// rows are kept, with nothing written to the clients. They may change the mapping (the plan
// follows), discard it, or commit it: the worker's `imports` queue then runs it in chunks,
// planning each chunk again against the clients as they are by then, and it can be undone
// for IMPORT_UNDO_DAYS. Client details never reach the audit log or the logs.

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
};

/** Imports the business's clients from a file it uploaded: the staged preview (AC-W1-17/18). */
export async function stageImport(
  db: Database,
  actor: Actor,
  bytes: Uint8Array,
  options: { format?: ImportFormat | undefined } = {},
): Promise<ImportPreview> {
  requirePermission(actor, 'clients.manage');
  // Before any transaction: a file that can't be read is refused with its reason.
  const table = parseImportFile(bytes, options.format);
  const { preset, columns } = suggestMapping(table);
  const mapping = mappingOf(columns);
  return withMember(db, actor.context, async (tx) => {
    const batch = await insertImportBatch(tx, {
      createdByUserId: actor.context.userId,
      format: table.format,
      preset,
      system: preset ?? fileSystem(table.columns),
      columns,
      problems: mappingProblems(mapping),
      counts: EMPTY_COUNTS,
    });
    const id = ImportBatchIdSchema.parse(batch.id);
    const counts = await planAndStore(tx, id, table, mapping, batch.system);
    const updated = await updateImportBatch(tx, id, { counts });
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
      return { ...column, field, by: field === null ? null : 'owner' };
    });
    const mapping = mappingOf(columns);
    const table = await tableOf(tx, batch, before);
    const counts = await planAndStore(tx, id, table, mapping, batch.system);
    const updated = await updateImportBatch(tx, id, {
      columns,
      problems: mappingProblems(mapping),
      counts,
    });
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
    if (counts.create + counts.merge === 0) {
      throw new ImportNotReadyError(
        'There’s nothing to import: every row is invalid, skipped or already a client.',
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
 * Undoes a finished import within IMPORT_UNDO_DAYS (AC-W1-19): its new clients go unless they
 * have a booking or waitlist entry since, the emails and phones it filled are cleared where
 * unchanged, and its rows' client details are cleared (D-5).
 */
export async function undoImport(
  db: Database,
  actor: Actor,
  batchId: ImportBatchId,
  clock: Clock,
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
    const undo = await undoImportBatchRows(tx, id);
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
): Promise<ImportRunResult> {
  const id = ImportBatchIdSchema.parse(job.batchId);
  const lease = () => new Date(clock.now().getTime() + IMPORT_LEASE_MS);
  const claimed = await withTenant(db, job.tenantId, (tx) =>
    claimImportBatch(tx, id, clock.now(), lease()),
  );
  if (claimed === undefined) return 'not_due';
  if (claimed.attempts > IMPORT_MAX_ATTEMPTS) {
    await withTenant(db, job.tenantId, (tx) => finish(tx, id, 'failed', clock));
    return 'failed';
  }
  for (;;) {
    const more = await withTenant(db, job.tenantId, async (tx) => {
      await lockTenantImports(tx);
      const batch = await lockImportBatch(tx, id);
      if (batch?.status !== 'running') return false;
      const pending = (await listImportRows(tx, id)).filter((row) => row.appliedAt === null);
      if (pending.length === 0) {
        await finish(tx, id, 'done', clock);
        return false;
      }
      await applyChunk(tx, batch, pending.slice(0, IMPORT_RUN_CHUNK), clock.now());
      await updateImportBatch(tx, id, { leaseUntil: lease() });
      return true;
    });
    if (!more) return 'done';
  }
}

async function applyChunk(
  tx: TenantTx,
  batch: ImportBatchRow,
  rows: readonly ImportRowRow[],
  now: Date,
): Promise<void> {
  const id = ImportBatchIdSchema.parse(batch.id);
  const format = batch.format as ImportFormat;
  // The row as staged; invalid rows stay invalid (their reasons were given in the preview).
  const mapped: MappedRow[] = rows.map((row) => ({
    row: row.row,
    name: row.name,
    email: row.email,
    phone: row.phone,
    externalId: row.externalId,
    hash: row.rowHash,
    valid: row.outcome !== 'invalid',
    reasons: row.outcome === 'invalid' ? ReasonsSchema.parse(row.reasons) : [],
  }));
  const plan = planRows(format, mapped, await matchIndex(tx, mapped, batch.system));
  const created = plan.flatMap((planned, i) =>
    planned.outcome === 'create' ? [{ i, id: newId() }] : [],
  );
  const createdIds = new Map(created.map(({ i, id: clientId }) => [i, clientId]));
  await insertImportedClients(
    tx,
    created.map(({ i, id: clientId }) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
      const row = mapped[i]!;
      return { id: clientId, name: row.name ?? '', email: row.email, phone: row.phone };
    }),
  );
  const applied: Pick<
    ImportRowValues,
    'position' | 'outcome' | 'reasons' | 'clientId' | 'fills'
  >[] = [];
  const refs: { externalId: string; clientId: string }[] = [];
  for (const [i, planned] of plan.entries()) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const row = rows[i]!;
    const clientId = createdIds.get(i) ?? planned.clientId;
    let outcome: ImportRowOutcome = planned.outcome;
    let fills: PlannedRow['fills'] = {};
    if (planned.outcome === 'merge' && planned.clientId !== null) {
      // Only what is still empty is filled (someone may have added it since the plan).
      fills = await fillClientContact(tx, planned.clientId, planned.fills);
      if (Object.keys(fills).length === 0) outcome = 'unchanged';
    }
    if (clientId !== null && row.externalId !== null) {
      refs.push({ externalId: row.externalId, clientId });
    }
    applied.push({ position: row.position, outcome, reasons: planned.reasons, clientId, fills });
  }
  await insertImportRefs(tx, id, batch.system, refs);
  await markImportRowsApplied(tx, id, applied, now);
}

async function finish(
  tx: TenantTx,
  id: ImportBatchId,
  status: 'done' | 'failed',
  clock: Clock,
): Promise<void> {
  const now = clock.now();
  const counts = countRows(await listImportRows(tx, id));
  await updateImportBatch(tx, id, {
    status,
    counts,
    finishedAt: now,
    undoUntil: new Date(now.getTime() + IMPORT_UNDO_DAYS * DAY_MS),
    leaseUntil: null,
  });
  const { create, merge, unchanged, invalid, skipped } = counts;
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'client_import.finished',
      entity: { type: 'client_import', id },
      before: null,
      after: { create, merge, unchanged, invalid, skipped, status },
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

/** Plans the table under `mapping` and stores its rows; returns the preview's counts. */
async function planAndStore(
  tx: TenantTx,
  id: ImportBatchId,
  table: Table,
  mapping: ImportMapping,
  system: string,
): Promise<ImportCounts> {
  const mapped = mapRows(table, mapping);
  const plan = planRows(table.format, mapped, await matchIndex(tx, mapped, system));
  const rows: ImportRowValues[] = plan.map((planned, position) => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- one row per plan entry
    const row = mapped[position]!;
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
      outcome: planned.outcome,
      reasons: planned.reasons,
      clientId: planned.clientId,
      fills: planned.fills,
    };
  });
  await replaceImportRows(tx, id, rows);
  return countRows(rows);
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
  const byRef = await findClientsByImportRefs(tx, system, unique(valid.map((r) => r.externalId)));
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
    byExternalId: new Map(byRef.map((client) => [client.externalId, known(client)])),
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
});

function countRows(rows: readonly { outcome: string }[]): ImportCounts {
  const counts = { ...EMPTY_COUNTS, rows: rows.length };
  for (const { outcome } of rows) counts[outcome as ImportRowOutcome] += 1;
  return counts;
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
  };
}

function toBatch(row: ImportBatchRow): ImportBatch {
  return ImportBatchSchema.parse({
    id: row.id,
    status: row.status,
    format: row.format,
    preset: row.preset,
    columns: row.columns,
    problems: row.problems,
    counts: row.counts,
    createdAt: row.createdAt.toISOString(),
    committedAt: row.committedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    undoUntil: row.undoUntil?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    undo: row.undo === null ? null : ImportUndoSchema.parse(row.undo),
  });
}
