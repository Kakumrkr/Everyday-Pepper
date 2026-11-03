import {
  ImportBatchIdSchema,
  ImportBatchSchema,
  ImportFieldSchema,
  ImportPreviewSchema,
  MAX_IMPORT_BYTES,
  SINGLE_IMPORT_FIELDS,
  type ImportBatch,
  type ImportBatchId,
  type ImportColumn,
  type ImportCounts,
  type ImportField,
  type ImportFormat,
  type ImportKind,
  type ImportLaterField,
  type ImportMapping,
  type ImportPreset,
  type ImportPreview,
  type ImportRow,
  type ImportVisit,
} from '@pepper/contracts';
import { z } from 'zod';
import { ROUTES } from './account';
import { errorCodeOf, messageFor, type CallResult } from './client-api';

// Client import in the browser (S48.2, ADR-0049, AC-W1-17…21): the owner's file sent as it is,
// the mapping changed column by column, the preview in one sentence with the rows to fix first,
// the import committed, followed while the worker runs, and undone. A visits file (S49.2,
// ADR-0050, AC-W1-27…29) speaks of visits, lists the times taken, and links its new clients.

/** The import screen's path; `?batch=` resumes an import after a refresh or a link. */
export const IMPORT_PATH = '/clients/import';

export function importHref(id: ImportBatchId): string {
  return `${IMPORT_PATH}?batch=${encodeURIComponent(id)}`;
}

/**
 * The import an address names (`?batch=`), or `null`. Back to the screen after "Book again" can
 * restore the page as first rendered, before the address named its import; the screen then
 * resumes the import from here.
 */
export function batchInAddress(search: string): ImportBatchId | null {
  const parsed = ImportBatchIdSchema.safeParse(new URLSearchParams(search).get('batch'));
  return parsed.success ? parsed.data : null;
}

/** What the file picker offers: the extensions, and the types a phone may label them with. */
export const ACCEPTED_IMPORT_TYPES =
  '.csv,.json,.jsonl,.ndjson,.txt,text/csv,text/plain,application/json,application/x-ndjson';

/** The format a file's name says, when it says one; the api reads the content otherwise. */
export function importFormatOf(fileName: string): ImportFormat | undefined {
  const extension = /\.([a-z]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (extension === 'csv') return 'csv';
  if (extension === 'json') return 'json';
  if (extension === 'jsonl' || extension === 'ndjson') return 'jsonl';
  return undefined;
}

/**
 * How the file goes to the api: CSV and JSONL as text, everything else as bytes (a JSON body
 * labelled `application/json` would be read as a request, not as the owner's file).
 */
function contentTypeOf(format: ImportFormat | undefined): string {
  if (format === 'csv') return 'text/csv';
  if (format === 'jsonl') return 'application/x-ndjson';
  return 'application/octet-stream';
}

/** Why a picked file can't be sent, before sending it; `null` when it may be. */
export function precheckImport(file: { size: number }): string | null {
  if (file.size === 0)
    return 'That file is empty. Export your clients again and pick the new file.';
  if (file.size > MAX_IMPORT_BYTES) return TOO_LARGE;
  return null;
}

const TOO_LARGE =
  'That file is over 5 MB. Export fewer clients at a time, or split the file in two.';

// What each refusal says when the api doesn't say more itself.
const IMPORT_MESSAGES: Record<string, string> = {
  import_not_found: 'That import is gone. Start a new one.',
  import_too_large: TOO_LARGE,
  import_rejected: 'I couldn’t read that file. Export it again as CSV or JSON and try again.',
  import_not_staged: 'That import has already started. Here is where it is.',
  import_not_ready: 'Fix the columns first: no column gives a name.',
  import_mapping_invalid: 'That mapping doesn’t fit the file. Check the columns again.',
  import_not_undoable: 'This import can’t be undone any more.',
};

/** The refusal's own sentence for an import code ("Row 4: …"), else ours, else the app's. */
export function importMessageFor(status: number, body: unknown): string {
  const code = errorCodeOf(body);
  if (code === undefined || !(code in IMPORT_MESSAGES)) return messageFor(status, body);
  const own =
    typeof body === 'object' && body !== null && 'message' in body ? body.message : undefined;
  // `import_too_large` carries the api's generic words; ours say what to do.
  if (code !== 'import_too_large' && typeof own === 'string' && own !== '') return own;
  return IMPORT_MESSAGES[code] ?? messageFor(status, body);
}

const OFFLINE = 'You seem to be offline. Check your connection.';
const FALLBACK = 'Something went wrong. Try again.';

async function call<T extends z.ZodType>(
  fetch: typeof globalThis.fetch,
  path: string,
  init: RequestInit,
  schema: T,
): Promise<CallResult<z.infer<T>>> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' });
  } catch {
    return { ok: false, status: 0, message: OFFLINE };
  }
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message: importMessageFor(response.status, data),
      body: data,
    };
  }
  const parsed = schema.safeParse(data);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, message: FALLBACK };
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Stages the owner's file (`POST /v1/imports`): nothing reaches the clients yet. */
export function uploadImport(
  file: Blob & { name?: string },
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<ImportPreview>> {
  const format = importFormatOf(file.name ?? '');
  const query = format === undefined ? '' : `?format=${format}`;
  return call(
    fetch,
    `/v1/imports${query}`,
    { method: 'POST', headers: { 'content-type': contentTypeOf(format) }, body: file },
    ImportPreviewSchema,
  );
}

/** An import with its preview rows (`GET /v1/imports/:id`). */
export function loadImport(
  id: ImportBatchId,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<ImportPreview>> {
  return call(fetch, `/v1/imports/${id}`, { method: 'GET' }, ImportPreviewSchema);
}

/** The preview under the owner's mapping (`PUT /v1/imports/:id/mapping`). */
export function remapImport(
  id: ImportBatchId,
  columns: ImportMapping,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<ImportPreview>> {
  return call(
    fetch,
    `/v1/imports/${id}/mapping`,
    { method: 'PUT', ...json({ columns }) },
    ImportPreviewSchema,
  );
}

/** Imports the staged batch (`POST /v1/imports/:id/commit`); the worker runs it. */
export function commitImport(
  id: ImportBatchId,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<ImportBatch>> {
  return call(fetch, `/v1/imports/${id}/commit`, { method: 'POST' }, ImportBatchSchema);
}

/** Undoes a finished import (`POST /v1/imports/:id/undo`). */
export function undoImport(
  id: ImportBatchId,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<ImportBatch>> {
  return call(fetch, `/v1/imports/${id}/undo`, { method: 'POST' }, ImportBatchSchema);
}

/** Throws a staged import away (`DELETE /v1/imports/:id`). */
export function discardImport(
  id: ImportBatchId,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<CallResult<null>> {
  return call(fetch, `/v1/imports/${id}`, { method: 'DELETE' }, z.null());
}

/** The screen's steps; mapping and preview are both a staged import's. */
export function importSteps(kind: ImportKind): readonly string[] {
  return ['Pick a file', 'Check the columns', `Check the ${kind}`, 'Done'];
}
export type ImportStep = 'upload' | 'mapping' | 'preview' | 'result';

export function stepIndex(step: ImportStep): number {
  return { upload: 0, mapping: 1, preview: 2, result: 3 }[step];
}

/** Where an import opens: a staged one at its preview, one that started at its result. */
export function stepOf(batch: ImportBatch | null): ImportStep {
  if (batch === null) return 'upload';
  return batch.status === 'staged' ? 'preview' : 'result';
}

/** Still running: the result screen asks again. */
export function inProgress(batch: ImportBatch): boolean {
  return batch.status === 'queued' || batch.status === 'running';
}

/** How often, and for how long, the result screen asks while the worker runs. */
export const POLL_MS = 1500;
export const POLL_LIMIT_MS = 10 * 60 * 1000;

export const count = (n: number, one: string, many: string) =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The preview in one sentence (AC-W1-21): "143 new clients, 12 to fill in, 3 to fix", then the
 * duplicates left out and the clients already here, only when there are any. A visits file's
 * (AC-W1-27): "40 past visits, 6 upcoming, 12 new clients, 3 to fix", then the times taken,
 * the rows left out and the visits already here, only when there are any.
 */
export function previewSentence(counts: ImportCounts, kind: ImportKind = 'clients'): string {
  const parts =
    kind === 'visits'
      ? [
          count(counts.past, 'past visit', 'past visits'),
          `${String(counts.upcoming)} upcoming`,
          count(counts.clients, 'new client', 'new clients'),
          `${String(counts.invalid)} to fix`,
          ...(counts.conflict > 0 ? [count(counts.conflict, 'time taken', 'times taken')] : []),
        ]
      : [
          count(counts.create, 'new client', 'new clients'),
          `${String(counts.merge)} to fill in`,
          `${String(counts.invalid)} to fix`,
        ];
  if (counts.skipped > 0) parts.push(`${String(counts.skipped)} left out`);
  if (counts.unchanged > 0) parts.push(`${String(counts.unchanged)} already here`);
  return parts.join(', ');
}

/** "a, b and c". */
function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`;
}

/** What a visits file added: "40 past visits, 6 upcoming appointments and 12 new clients". */
function visitsAdded(counts: ImportCounts): string {
  const parts = [
    ...(counts.past > 0 ? [count(counts.past, 'past visit', 'past visits')] : []),
    ...(counts.upcoming > 0
      ? [count(counts.upcoming, 'upcoming appointment', 'upcoming appointments')]
      : []),
    ...(counts.clients > 0 ? [count(counts.clients, 'new client', 'new clients')] : []),
  ];
  return parts.length === 0 ? 'nothing' : listed(parts);
}

/** What the import did, or is doing, in words. */
export function resultSentence(batch: ImportBatch): string {
  const { counts, kind } = batch;
  const did =
    kind === 'visits'
      ? `Added ${visitsAdded(counts)}`
      : [
          `${count(counts.create, 'new client', 'new clients')} added`,
          ...(counts.merge > 0 ? [`${String(counts.merge)} filled in`] : []),
        ].join(', ');
  switch (batch.status) {
    case 'staged':
      return previewSentence(counts, kind);
    case 'queued':
    case 'running':
      return `Importing ${count(counts.rows, 'row', 'rows')}. You can leave this screen; I’ll keep going.`;
    case 'done': {
      // An import never emails (AC-W1-24): said where the owner would worry about it. The
      // times taken are the result's own list ("Book these again"), not repeated here.
      const quiet = kind === 'visits' && counts.upcoming > 0 ? ' No one was emailed.' : '';
      return `${did}.${quiet}`;
    }
    case 'failed':
      return `${did} before it stopped. Undo it, or try the file again later.`;
    case 'undone': {
      const undo = batch.undo ?? { deleted: 0, restored: 0, kept: 0, bookings: 0, bookingsKept: 0 };
      if (kind === 'visits') {
        const restored = undo.restored > 0 ? `, ${String(undo.restored)} cleared again` : '';
        const keptVisits =
          undo.bookingsKept > 0
            ? ` ${count(undo.bookingsKept, 'visit was', 'visits were')} kept: ${undo.bookingsKept === 1 ? 'it' : 'they'} changed since.`
            : '';
        const keptClients =
          undo.kept > 0
            ? ` ${count(undo.kept, 'client was', 'clients were')} kept: they booked or changed since.`
            : '';
        return `Undone: ${count(undo.bookings, 'visit', 'visits')} and ${count(undo.deleted, 'client', 'clients')} removed${restored}.${keptVisits}${keptClients}`;
      }
      const kept =
        undo.kept > 0
          ? ` ${count(undo.kept, 'client was', 'clients were')} kept: they booked or changed since.`
          : '';
      return `Undone: ${count(undo.deleted, 'client', 'clients')} removed, ${String(undo.restored)} cleared again.${kept}`;
    }
  }
}

/** Whether the import can be undone now (by the api's clock, which decides again). */
export function undoable(batch: ImportBatch, now: Date): boolean {
  if (batch.status !== 'done' && batch.status !== 'failed') return false;
  return batch.undoUntil !== null && new Date(batch.undoUntil).getTime() > now.getTime();
}

/** The undo's last day in the business's time zone: "Tuesday, November 10". */
export function undoUntilLabel(batch: ImportBatch, timeZone: string): string | null {
  if (batch.undoUntil === null) return null;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone,
  }).format(new Date(batch.undoUntil));
}

/**
 * The rows to fix first (AC-W1-21): can't be imported, then (a visits file's, AC-W1-27) the
 * upcoming times another booking holds, then left out; the rest after.
 */
export function rowsToFixFirst(rows: readonly ImportRow[]): {
  toFix: ImportRow[];
  taken: ImportRow[];
  leftOut: ImportRow[];
  rest: ImportRow[];
} {
  return {
    toFix: rows.filter((row) => row.outcome === 'invalid'),
    taken: rows.filter((row) => row.outcome === 'conflict'),
    leftOut: rows.filter((row) => row.outcome === 'skipped'),
    rest: rows.filter(
      (row) => row.outcome !== 'invalid' && row.outcome !== 'skipped' && row.outcome !== 'conflict',
    ),
  };
}

/**
 * A visit as a row shows it (AC-W1-27): the date with its year (history goes back years) in the
 * business's time zone, then the service and who it was with.
 */
export function visitLine(visit: ImportVisit, timeZone: string): string {
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(visit.startsAt));
  return `${when} · ${visit.service} with ${visit.staff}`;
}

type BadgeTone = 'ok' | 'info' | 'warn' | 'neutral';

const OUTCOME_BADGES: Record<ImportRow['outcome'], { label: string; tone: BadgeTone }> = {
  create: { label: 'New', tone: 'ok' },
  merge: { label: 'Fills in', tone: 'info' },
  unchanged: { label: 'Already here', tone: 'neutral' },
  invalid: { label: 'Fix', tone: 'warn' },
  skipped: { label: 'Left out', tone: 'neutral' },
  conflict: { label: 'Time taken', tone: 'warn' },
};

const VISIT_BADGES: Record<ImportVisit['status'], { label: string; tone: BadgeTone }> = {
  completed: { label: 'Past visit', tone: 'ok' },
  no_show: { label: 'No-show', tone: 'neutral' },
  confirmed: { label: 'Upcoming', tone: 'info' },
};

/** What a row does, as its badge: a visit it adds by what the visit becomes. */
export function rowBadge(row: ImportRow): { label: string; tone: BadgeTone } {
  if (row.outcome === 'create' && row.visit !== null) return VISIT_BADGES[row.visit.status];
  return OUTCOME_BADGES[row.outcome];
}

/**
 * Where "See your clients" goes (AC-W1-29): the Clients list filtered to the clients the import
 * added, when it added any and still has them; the whole list otherwise.
 */
export function clientsHref(batch: ImportBatch): string {
  const kept = batch.status === 'done' || batch.status === 'failed';
  return kept && batch.counts.clients > 0
    ? `${ROUTES.clients}?import=${encodeURIComponent(batch.id)}`
    : ROUTES.clients;
}

/** What "Book again" can preselect: the business's bookable services and its staff. */
export interface BookAgainChoices {
  services: readonly { id: string; name: string }[];
  staff: readonly { id: string; displayName: string }[];
}

/** A name as the import matches it (ADR-0050): ignoring case and spaces. */
const nameKey = (name: string) => name.toLowerCase().replace(/\s+/g, '');

/**
 * Where a time taken's "Book again" goes (AC-W1-33, the S49.2 retro top-up): the client's
 * profile with Book open, the visit's service and staff member chosen when they match by name
 * (a staff member by display name, or by first name when only one has it). Ids, never names,
 * in the address.
 */
export function bookAgainHref(
  clientId: string,
  visit: Pick<ImportVisit, 'service' | 'staff'> | null,
  choices: BookAgainChoices,
): string {
  const query = new URLSearchParams({ book: '1' });
  if (visit !== null) {
    const service = choices.services.find((s) => nameKey(s.name) === nameKey(visit.service));
    if (service !== undefined) query.set('service', service.id);
    const wanted = nameKey(visit.staff);
    const exact = choices.staff.filter((m) => nameKey(m.displayName) === wanted);
    const byFirst = choices.staff.filter(
      (m) => nameKey(m.displayName.trim().split(/\s+/)[0] ?? '') === wanted,
    );
    const staff = exact.length === 1 ? exact[0] : byFirst.length === 1 ? byFirst[0] : undefined;
    if (staff !== undefined) query.set('staff', staff.id);
  }
  return `${ROUTES.clients}/${clientId}?${query.toString()}`;
}

/**
 * The upcoming times a run left out because another booking held them (AC-W1-29), as the result
 * lists them with "Book again", and how many more the file has than the rows read.
 */
export function takenTimes(
  batch: ImportBatch,
  rows: readonly ImportRow[],
): { rows: ImportRow[]; more: number } {
  if (batch.status !== 'done' && batch.status !== 'failed') return { rows: [], more: 0 };
  const taken = rows.filter((row) => row.outcome === 'conflict');
  return { rows: taken, more: Math.max(0, batch.counts.conflict - taken.length) };
}

/**
 * What a preview cut at IMPORT_PREVIEW_ROWS leaves out, when it does: the rows to fix come
 * first, so the note says how many of them aren't shown.
 */
export function moreRowsNote(counts: ImportCounts, shown: readonly ImportRow[]): string | null {
  if (shown.length >= counts.rows) return null;
  const toFix = counts.invalid + counts.skipped;
  const fixShown = shown.filter((row) => row.outcome === 'invalid' || row.outcome === 'skipped');
  const hidden = toFix - fixShown.length;
  const of = `Showing ${String(shown.length)} of ${String(counts.rows)} rows`;
  if (hidden > 0) {
    return `${of}. ${count(hidden, 'more row to fix isn’t', 'more rows to fix aren’t')} shown: fix the ones above, then pick the file again.`;
  }
  // A visits file's times taken come before the rows left out: some may be beyond the cut.
  const takenHidden = counts.conflict - shown.filter((row) => row.outcome === 'conflict').length;
  return takenHidden > 0
    ? `${of}. ${count(takenHidden, 'more time taken isn’t', 'more times taken aren’t')} shown; the rest are ready to import.`
    : `${of}. The rest are ready to import.`;
}

/** The undo's confirmation in words, with what it takes back. */
export function undoQuestion(counts: ImportCounts, kind: ImportKind = 'clients'): string {
  if (kind === 'visits') {
    return `I’ll remove the ${count(counts.create, 'visit', 'visits')} and ${count(counts.clients, 'new client', 'new clients')} it added, and clear any email or phone it filled in. A visit changed since, and anyone who booked since, stays.`;
  }
  const added = count(counts.create, 'client', 'clients');
  return counts.merge > 0
    ? `I’ll remove the ${added} it added and clear the emails and phones it filled in. Anyone who booked since stays.`
    : `I’ll remove the ${added} it added. Anyone who booked since stays.`;
}

/** Home offers "Bring your clients" (AC-W1-20) until an import has finished, not undone. */
export function offersImport(imports: readonly ImportBatch[]): boolean {
  return !imports.some((batch) => batch.status === 'done');
}

const FIELD_WORDS: Record<ImportField, string> = {
  name: 'Full name',
  first_name: 'First name',
  last_name: 'Last name',
  email: 'Email',
  phone: 'Phone',
  external_id: 'Their id in your old app',
  birthday: 'Birthday',
  tags: 'Tags',
  visit_date: 'Visit date',
  visit_time: 'Visit time',
  visit_end: 'Visit end',
  duration: 'Length',
  service: 'Service',
  staff: 'Who did it',
  price: 'Price',
  status: 'Visit status',
  visit_id: 'Their id for the visit',
};

/** The choices for a column: what it can fill, or not imported. */
export const FIELD_OPTIONS: readonly { value: string; label: string }[] = [
  ...(Object.keys(FIELD_WORDS) as ImportField[]).map((field) => ({
    value: field,
    label: FIELD_WORDS[field],
  })),
  { value: '', label: 'Don’t import' },
];

const LATER_WORDS: Record<ImportLaterField, string> = {
  notes: 'Notes',
  visits: 'Visits',
};

const PRESET_NAMES: Record<ImportPreset, string> = {
  square: 'Square',
  booksy: 'Booksy',
  vagaro: 'Vagaro',
  glossgenius: 'GlossGenius',
  fresha: 'Fresha',
};

export function presetName(preset: ImportPreset): string {
  return PRESET_NAMES[preset];
}

/** Why a column fills what it does, in words, or what happens to a column Pepper skips. */
export function columnNote(column: ImportColumn, preset: ImportPreset | null): string {
  if (column.field === null) {
    if (column.later !== null) return `${LATER_WORDS[column.later]} come in a later update.`;
    return 'Not imported.';
  }
  switch (column.by) {
    case 'preset':
      return preset === null ? 'From the file’s layout.' : `As ${presetName(preset)} exports it.`;
    case 'header':
      return 'From the column’s name.';
    case 'values':
      return 'From what’s in it.';
    case 'owner':
      return 'You chose this.';
    case null:
      return '';
  }
}

/**
 * The mapping with one column changed (`''`: not imported). A field only one column may fill
 * moves to this column: the column that had it is no longer imported.
 */
export function withField(
  columns: readonly ImportColumn[],
  column: string,
  value: string,
): ImportMapping {
  const parsed = ImportFieldSchema.safeParse(value);
  const field = parsed.success ? parsed.data : null;
  return columns.map((each) => {
    if (each.column === column) return { column: each.column, field };
    const taken = field !== null && SINGLE_IMPORT_FIELDS.includes(field) && each.field === field;
    return { column: each.column, field: taken ? null : each.field };
  });
}
