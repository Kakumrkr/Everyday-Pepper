import {
  ClientEmailSchema,
  ImportBatchIdSchema,
  ImportFormatSchema,
  ImportPresetSchema,
  PhoneSchema,
  TenantIdSchema,
  type ImportBatchId,
  type ImportBatchStatus,
  type ImportFormat,
  type ImportPreset,
  type ImportRowOutcome,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  clientImportRefs,
  clients,
  importBatches,
  importRows,
  type ClientRow,
  type ImportBatchRow,
  type ImportRowRow,
} from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Client imports (S48, ADR-0049): batches, their rows, the external ids they record, and the
// lookups that match a file's rows to the business's clients. Run in the business's member
// transaction (owners and managers: the tables' member scope keeps staff out) or, for the
// worker, its tenant transaction. Rows hold client data: nothing here logs them.

const Id = z.uuid();
const Limit = z.number().int().min(1).max(500);
const System = z.string().regex(/^[a-z0-9:]{1,64}$/);
/** Rows written or updated per statement. */
const CHUNK = 500;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface NewImportBatch {
  createdByUserId: string | null;
  format: ImportFormat;
  preset: ImportPreset | null;
  system: string;
  columns: unknown;
  problems: readonly string[];
  counts: unknown;
}

export async function insertImportBatch(
  tx: TenantTx,
  batch: NewImportBatch,
): Promise<ImportBatchRow> {
  const [row] = await tx
    .insert(importBatches)
    .values({
      ...batch,
      format: ImportFormatSchema.parse(batch.format),
      preset: batch.preset === null ? null : ImportPresetSchema.parse(batch.preset),
      system: System.parse(batch.system),
      problems: [...batch.problems],
    })
    .returning();
  if (row === undefined) throw new Error('Insert returned no row');
  return row;
}

/** A row of a batch as it is planned (and, once applied, as it was applied). */
export interface ImportRowValues {
  position: number;
  row: number;
  cells: readonly string[];
  name: string | null;
  email: string | null;
  phone: string | null;
  externalId: string | null;
  rowHash: string;
  outcome: ImportRowOutcome;
  reasons: readonly { code: string; message: string }[];
  clientId: string | null;
  fills: Readonly<{ email?: string; phone?: string }>;
}

/** Replaces a staged batch's rows (a first plan, or a new mapping's). */
export async function replaceImportRows(
  tx: TenantTx,
  batchId: ImportBatchId,
  rows: readonly ImportRowValues[],
): Promise<void> {
  const id = Id.parse(batchId);
  await tx.delete(importRows).where(eq(importRows.batchId, id));
  for (const part of chunks(rows)) {
    await tx.insert(importRows).values(
      part.map((row) => ({
        ...row,
        batchId: id,
        cells: [...row.cells],
        reasons: [...row.reasons],
        fills: { ...row.fills },
      })),
    );
  }
}

/** Records what the run did with these rows (after it wrote their clients). */
export async function markImportRowsApplied(
  tx: TenantTx,
  batchId: ImportBatchId,
  rows: readonly Pick<ImportRowValues, 'position' | 'outcome' | 'reasons' | 'clientId' | 'fills'>[],
  at: Date,
): Promise<void> {
  const id = Id.parse(batchId);
  for (const part of chunks(rows)) {
    const values = sql.join(
      part.map(
        (row) =>
          sql`(${row.position}::int, ${row.outcome}::text, ${JSON.stringify(row.reasons)}::jsonb, ${row.clientId === null ? null : Id.parse(row.clientId)}::uuid, ${JSON.stringify(row.fills)}::jsonb)`,
      ),
      sql`, `,
    );
    await tx.execute(sql`
      UPDATE import_rows AS r
      SET outcome = v.outcome, reasons = v.reasons, client_id = v.client_id, fills = v.fills,
          applied_at = ${at}
      FROM (VALUES ${values}) AS v(position, outcome, reasons, client_id, fills)
      WHERE r.batch_id = ${id} AND r.position = v.position`);
  }
}

export async function findImportBatch(
  tx: TenantTx,
  id: ImportBatchId,
): Promise<ImportBatchRow | undefined> {
  const [row] = await tx
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, Id.parse(id)));
  return row;
}

/** The batch, locked until the transaction ends (a commit, a run's chunk and an undo take turns). */
export async function lockImportBatch(
  tx: TenantTx,
  id: ImportBatchId,
): Promise<ImportBatchRow | undefined> {
  const [row] = await tx
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, Id.parse(id)))
    .for('update');
  return row;
}

/** The business's latest imports, newest first. */
export function listImportBatches(tx: TenantTx, limit: number): Promise<ImportBatchRow[]> {
  return tx
    .select()
    .from(importBatches)
    .orderBy(desc(importBatches.createdAt), desc(importBatches.id))
    .limit(Limit.parse(limit));
}

export type ImportBatchChange = Partial<
  Pick<
    ImportBatchRow,
    | 'status'
    | 'columns'
    | 'problems'
    | 'counts'
    | 'undo'
    | 'committedAt'
    | 'finishedAt'
    | 'undoUntil'
    | 'undoneAt'
    | 'purgedAt'
    | 'availableAt'
    | 'leaseUntil'
  >
>;

export async function updateImportBatch(
  tx: TenantTx,
  id: ImportBatchId,
  change: ImportBatchChange,
): Promise<ImportBatchRow | undefined> {
  const [row] = await tx
    .update(importBatches)
    .set(change)
    .where(eq(importBatches.id, Id.parse(id)))
    .returning();
  return row;
}

/** Removes a batch and its rows (a staged one discarded, or left unused). */
export async function deleteImportBatch(tx: TenantTx, id: ImportBatchId): Promise<boolean> {
  const rows = await tx
    .delete(importBatches)
    .where(eq(importBatches.id, Id.parse(id)))
    .returning({ id: importBatches.id });
  return rows.length > 0;
}

/** All rows of a batch in file order. */
export function listImportRows(tx: TenantTx, batchId: ImportBatchId): Promise<ImportRowRow[]> {
  return tx
    .select()
    .from(importRows)
    .where(eq(importRows.batchId, Id.parse(batchId)))
    .orderBy(asc(importRows.position));
}

/** The rows a preview shows: invalid and skipped first, then in file order, at most `limit`. */
export function listImportPreviewRows(
  tx: TenantTx,
  batchId: ImportBatchId,
  limit: number,
): Promise<ImportRowRow[]> {
  return tx
    .select()
    .from(importRows)
    .where(eq(importRows.batchId, Id.parse(batchId)))
    .orderBy(
      sql`CASE ${importRows.outcome} WHEN 'invalid' THEN 0 WHEN 'skipped' THEN 1 ELSE 2 END`,
      asc(importRows.position),
    )
    .limit(Limit.parse(limit));
}

/** Clears a batch's client data from its rows, keeping identity, outcome and client (D-5). */
export async function purgeImportRows(tx: TenantTx, batchId: ImportBatchId): Promise<void> {
  await tx
    .update(importRows)
    .set({
      cells: null,
      name: null,
      email: null,
      phone: null,
      externalId: null,
      reasons: [],
    })
    .where(eq(importRows.batchId, Id.parse(batchId)));
}

// Matching ----------------------------------------------------------------------------------

export type MatchClient = Pick<ClientRow, 'id' | 'name' | 'email' | 'phone'>;
const matchColumns = {
  id: clients.id,
  name: clients.name,
  email: clients.email,
  phone: clients.phone,
};

/** The business's clients with any of these emails. */
export async function findClientsByEmails(
  tx: TenantTx,
  emails: readonly string[],
): Promise<MatchClient[]> {
  const out: MatchClient[] = [];
  for (const part of chunks(z.array(ClientEmailSchema).parse(emails))) {
    out.push(...(await tx.select(matchColumns).from(clients).where(inArray(clients.email, part))));
  }
  return out;
}

/** The business's clients with any of these phones. */
export async function findClientsByPhones(
  tx: TenantTx,
  phones: readonly string[],
): Promise<MatchClient[]> {
  const out: MatchClient[] = [];
  for (const part of chunks(z.array(PhoneSchema).parse(phones))) {
    out.push(...(await tx.select(matchColumns).from(clients).where(inArray(clients.phone, part))));
  }
  return out;
}

/** The clients these external ids of `system` point at. */
export async function findClientsByImportRefs(
  tx: TenantTx,
  system: string,
  externalIds: readonly string[],
): Promise<(MatchClient & { externalId: string })[]> {
  const out: (MatchClient & { externalId: string })[] = [];
  for (const part of chunks(externalIds)) {
    out.push(
      ...(await tx
        .select({ ...matchColumns, externalId: clientImportRefs.externalId })
        .from(clientImportRefs)
        .innerJoin(clients, eq(clients.id, clientImportRefs.clientId))
        .where(
          and(
            eq(clientImportRefs.system, System.parse(system)),
            inArray(clientImportRefs.externalId, part),
          ),
        )),
    );
  }
  return out;
}

/**
 * The clients identical rows (by hash) of the business's earlier imports created or matched,
 * leaving out undone imports, rows not applied and clients since deleted.
 */
export async function findClientsByImportHashes(
  tx: TenantTx,
  hashes: readonly string[],
): Promise<(MatchClient & { rowHash: string })[]> {
  const out: (MatchClient & { rowHash: string })[] = [];
  for (const part of chunks(hashes)) {
    out.push(
      ...(await tx
        .selectDistinctOn([importRows.rowHash], { ...matchColumns, rowHash: importRows.rowHash })
        .from(importRows)
        .innerJoin(importBatches, eq(importBatches.id, importRows.batchId))
        .innerJoin(clients, eq(clients.id, importRows.clientId))
        .where(
          and(
            inArray(importRows.rowHash, part),
            sql`${importRows.appliedAt} IS NOT NULL`,
            inArray(importBatches.status, ['running', 'done', 'failed']),
          ),
        )
        .orderBy(importRows.rowHash, asc(importRows.appliedAt))),
    );
  }
  return out;
}

// Applying ----------------------------------------------------------------------------------

export interface NewImportedClient {
  /** Made by the caller, so each row knows its client without relying on insert order. */
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** Inserts the clients a run creates (`source` import). */
export async function insertImportedClients(
  tx: TenantTx,
  rows: readonly NewImportedClient[],
): Promise<void> {
  for (const part of chunks(rows)) {
    await tx.insert(clients).values(
      part.map((row) => ({
        id: Id.parse(row.id),
        name: row.name,
        email: row.email === null ? null : ClientEmailSchema.parse(row.email),
        phone: row.phone === null ? null : PhoneSchema.parse(row.phone),
        source: 'import',
      })),
    );
  }
}

/**
 * Fills a client's email and phone where they are still empty (a merge never overwrites);
 * returns the fields it filled.
 */
export async function fillClientContact(
  tx: TenantTx,
  id: string,
  fills: { email?: string; phone?: string },
): Promise<{ email?: string; phone?: string }> {
  const filled: { email?: string; phone?: string } = {};
  if (fills.email !== undefined) {
    const email = ClientEmailSchema.parse(fills.email);
    const done = await tx
      .update(clients)
      .set({ email })
      .where(and(eq(clients.id, Id.parse(id)), isNull(clients.email)))
      .returning({ id: clients.id });
    if (done.length > 0) filled.email = email;
  }
  if (fills.phone !== undefined) {
    const phone = PhoneSchema.parse(fills.phone);
    const done = await tx
      .update(clients)
      .set({ phone })
      .where(and(eq(clients.id, Id.parse(id)), isNull(clients.phone)))
      .returning({ id: clients.id });
    if (done.length > 0) filled.phone = phone;
  }
  return filled;
}

/** Records external ids for clients; an id the system already has stays with its client. */
export async function insertImportRefs(
  tx: TenantTx,
  batchId: ImportBatchId,
  system: string,
  refs: readonly { externalId: string; clientId: string }[],
): Promise<void> {
  const batch = Id.parse(batchId);
  const scope = System.parse(system);
  for (const part of chunks(refs)) {
    await tx
      .insert(clientImportRefs)
      .values(
        part.map((ref) => ({
          system: scope,
          externalId: ref.externalId,
          clientId: Id.parse(ref.clientId),
          batchId: batch,
        })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Undoes what a batch wrote (AC-W1-19): removes the clients it created that have no booking or
 * waitlist entry, clears the emails and phones it filled where they still hold its value, and
 * removes the external ids it recorded. Returns the counts.
 */
export async function undoImportBatchRows(
  tx: TenantTx,
  batchId: ImportBatchId,
): Promise<{ deleted: number; restored: number; kept: number }> {
  const id = Id.parse(batchId);
  await tx.delete(clientImportRefs).where(eq(clientImportRefs.batchId, id));
  const created = await tx.execute<{ total: number; deleted: number }>(sql`
    WITH created AS (
      SELECT client_id FROM import_rows
      WHERE batch_id = ${id} AND outcome = 'create' AND applied_at IS NOT NULL
        AND client_id IS NOT NULL
    ), removed AS (
      DELETE FROM clients c USING created
      WHERE c.id = created.client_id
        AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM waitlist_entries w WHERE w.client_id = c.id)
      RETURNING c.id
    )
    SELECT (SELECT count(*) FROM created c JOIN clients k ON k.id = c.client_id)::int AS total,
           (SELECT count(*) FROM removed)::int AS deleted`);
  const restored = await tx.execute<{ restored: number }>(sql`
    WITH emails AS (
      UPDATE clients c SET email = NULL FROM import_rows r
      WHERE r.batch_id = ${id} AND r.outcome = 'merge' AND r.applied_at IS NOT NULL
        AND r.client_id = c.id AND r.fills ? 'email' AND c.email = r.fills->>'email'
      RETURNING c.id
    ), phones AS (
      UPDATE clients c SET phone = NULL FROM import_rows r
      WHERE r.batch_id = ${id} AND r.outcome = 'merge' AND r.applied_at IS NOT NULL
        AND r.client_id = c.id AND r.fills ? 'phone' AND c.phone = r.fills->>'phone'
      RETURNING c.id
    )
    SELECT (SELECT count(DISTINCT id) FROM (SELECT id FROM emails UNION ALL SELECT id FROM phones) x)::int
      AS restored`);
  const counts = created.rows[0] ?? { total: 0, deleted: 0 };
  return {
    deleted: counts.deleted,
    // `total` counts the created clients still there before the delete (the CTE's snapshot).
    kept: counts.total - counts.deleted,
    restored: restored.rows[0]?.restored ?? 0,
  };
}

/** Serialises a business's import runs and undos until the transaction ends. */
export async function lockTenantImports(tx: TenantTx): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('client_imports'), hashtext(current_tenant_id()::text))`,
  );
}

// The worker --------------------------------------------------------------------------------

export interface DueImportBatch {
  batchId: ImportBatchId;
  tenantId: TenantId;
}

/** Committed batches due at `now` (not leased, or the lease ran out), across businesses. */
export async function listDueImportBatches(
  db: Database,
  now: Date,
  limit: number,
): Promise<DueImportBatch[]> {
  const rows = await withJobScan(db, 'imports', (tx) =>
    tx
      .select({ id: importBatches.id, tenantId: importBatches.tenantId })
      .from(importBatches)
      .where(
        and(
          inArray(importBatches.status, ['queued', 'running']),
          lte(importBatches.availableAt, now),
          or(isNull(importBatches.leaseUntil), lte(importBatches.leaseUntil, now)),
        ),
      )
      .orderBy(asc(importBatches.availableAt), asc(importBatches.id))
      .limit(Limit.parse(limit)),
  );
  return rows.map((row) => ({
    batchId: ImportBatchIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
  }));
}

/**
 * Claims a due batch for `leaseUntil` (it is `running`) and counts the attempt; `undefined`
 * when it isn't due or another worker holds it. Commit the claim before working on it.
 */
export async function claimImportBatch(
  tx: TenantTx,
  id: ImportBatchId,
  now: Date,
  leaseUntil: Date,
): Promise<ImportBatchRow | undefined> {
  const [row] = await tx
    .update(importBatches)
    .set({ status: 'running', leaseUntil, attempts: sql`${importBatches.attempts} + 1` })
    .where(
      and(
        eq(importBatches.id, Id.parse(id)),
        inArray(importBatches.status, ['queued', 'running']),
        lte(importBatches.availableAt, now),
        or(isNull(importBatches.leaseUntil), lte(importBatches.leaseUntil, now)),
      ),
    )
    .returning();
  return row;
}

export interface ImportHousekeeping {
  batchId: ImportBatchId;
  tenantId: TenantId;
  /** `discard`: staged and never committed; `purge`: its undo window is over. */
  action: 'discard' | 'purge';
}

/**
 * Batches to tidy at `now`, across businesses (D-5): staged ones older than `stagedBefore`,
 * and finished ones whose undo window is over and whose rows still hold client data.
 */
export async function listImportHousekeeping(
  db: Database,
  now: Date,
  stagedBefore: Date,
  limit: number,
): Promise<ImportHousekeeping[]> {
  const rows = await withJobScan(db, 'imports', (tx) =>
    tx
      .select({
        id: importBatches.id,
        tenantId: importBatches.tenantId,
        status: importBatches.status,
      })
      .from(importBatches)
      .where(
        or(
          and(eq(importBatches.status, 'staged'), lte(importBatches.createdAt, stagedBefore)),
          and(
            inArray(importBatches.status, ['done', 'failed', 'undone']),
            isNull(importBatches.purgedAt),
            or(lte(importBatches.undoUntil, now), eq(importBatches.status, 'undone')),
          ),
        ),
      )
      .orderBy(asc(importBatches.createdAt))
      .limit(Limit.parse(limit)),
  );
  return rows.map((row) => ({
    batchId: ImportBatchIdSchema.parse(row.id),
    tenantId: TenantIdSchema.parse(row.tenantId),
    action: (row.status as ImportBatchStatus) === 'staged' ? 'discard' : 'purge',
  }));
}
