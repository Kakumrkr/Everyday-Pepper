import { z } from 'zod';
import { ClientIdSchema } from './clients.js';
import { UtcDateTimeSchema } from './time.js';

// Client import (S48, ADR-0049, AC-W1-3, AC-W1-17…19): an owner uploads a client export from
// another tool (CSV, JSON or JSONL), Pepper suggests how its columns map onto a client, shows
// what each row would do, and imports the batch on commit; the whole batch can be undone for
// IMPORT_UNDO_DAYS. Rows hold clients' personal data: they are shown to owners and managers of
// the business only, and never logged or audited.

export const IMPORT_FORMATS = ['csv', 'json', 'jsonl'] as const;
export const ImportFormatSchema = z.enum(IMPORT_FORMATS);
export type ImportFormat = z.infer<typeof ImportFormatSchema>;

/** The tools whose client exports Pepper recognises by their headers. */
export const IMPORT_PRESETS = ['square', 'booksy', 'vagaro', 'glossgenius', 'fresha'] as const;
export const ImportPresetSchema = z.enum(IMPORT_PRESETS);
export type ImportPreset = z.infer<typeof ImportPresetSchema>;

/**
 * What a column can fill. A client's name comes from `name`, or from `first_name` and
 * `last_name` together; `external_id` is the other tool's id for the client, used to find them
 * again on a re-import. Email and phone may come from several columns: the first valid value
 * in column order wins (e.g. a cell phone, then a home phone).
 */
export const IMPORT_FIELDS = [
  'name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'external_id',
] as const;
export const ImportFieldSchema = z.enum(IMPORT_FIELDS);
export type ImportField = z.infer<typeof ImportFieldSchema>;

/** Fields an export may have that Pepper recognises but doesn't import yet (S49). */
export const IMPORT_LATER_FIELDS = ['birthday', 'notes', 'tags', 'visits'] as const;
export const ImportLaterFieldSchema = z.enum(IMPORT_LATER_FIELDS);
export type ImportLaterField = z.infer<typeof ImportLaterFieldSchema>;

/** The largest file an import takes (D-5). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** The most rows one import takes. */
export const MAX_IMPORT_ROWS = 10_000;
/** The most columns a file may have. */
export const MAX_IMPORT_COLUMNS = 100;
/** The longest column name. */
export const MAX_IMPORT_COLUMN_LENGTH = 200;
/** How long a finished import can be undone (D-4). */
export const IMPORT_UNDO_DAYS = 7;
/** The most rows a preview answer carries (invalid and skipped rows first). */
export const IMPORT_PREVIEW_ROWS = 200;

/** An import's id: a lowercased UUID. */
export const ImportBatchIdSchema = z.uuid().toLowerCase().brand<'ImportBatchId'>();
export type ImportBatchId = z.infer<typeof ImportBatchIdSchema>;

/** Fields one column at most may fill. */
export const SINGLE_IMPORT_FIELDS: readonly ImportField[] = [
  'name',
  'first_name',
  'last_name',
  'external_id',
];

/** One column of the file and what it fills (`null`: not imported). */
export const ImportColumnMappingSchema = z
  .object({
    column: z.string().min(1).max(MAX_IMPORT_COLUMN_LENGTH),
    field: ImportFieldSchema.nullable(),
  })
  .strict();
export type ImportColumnMapping = z.infer<typeof ImportColumnMappingSchema>;

/** A mapping: each column once; name, first and last name and the external id at most once. */
export const ImportMappingSchema = z
  .array(ImportColumnMappingSchema)
  .min(1)
  .max(MAX_IMPORT_COLUMNS)
  .superRefine((columns, ctx) => {
    const seen = new Set<string>();
    const filled = new Set<ImportField>();
    for (const { column, field } of columns) {
      if (seen.has(column))
        ctx.addIssue({ code: 'custom', message: `"${column}" is listed twice` });
      seen.add(column);
      if (field === null) continue;
      if (SINGLE_IMPORT_FIELDS.includes(field) && filled.has(field)) {
        ctx.addIssue({ code: 'custom', message: `Only one column can be ${field}` });
      }
      filled.add(field);
    }
  });
export type ImportMapping = z.infer<typeof ImportMappingSchema>;

/** `PUT /v1/imports/:id/mapping`: the owner's mapping for a staged import. */
export const ImportMappingInputSchema = z.object({ columns: ImportMappingSchema }).strict();
export type ImportMappingInput = z.infer<typeof ImportMappingInputSchema>;

/** `POST /v1/imports?format=`: the format, when the content alone shouldn't decide it. */
export const ImportUploadQuerySchema = z.object({ format: ImportFormatSchema.optional() }).strict();

/** How a column's field was chosen: by the tool's preset, its header, its values, or the owner. */
export const ImportMappedBySchema = z.enum(['preset', 'header', 'values', 'owner']);
export type ImportMappedBy = z.infer<typeof ImportMappedBySchema>;

/** A column of the file as the preview shows it. */
export const ImportColumnSchema = z.object({
  column: z.string(),
  field: ImportFieldSchema.nullable(),
  by: ImportMappedBySchema.nullable(),
  /** A field Pepper recognised but doesn't import yet. */
  later: ImportLaterFieldSchema.nullable(),
});
export type ImportColumn = z.infer<typeof ImportColumnSchema>;

/**
 * What a row does (or did, once the import ran): becomes a new client, fills empty fields of
 * the client it matches, matches one with nothing to add, can't be imported, or is skipped.
 */
export const IMPORT_ROW_OUTCOMES = ['create', 'merge', 'unchanged', 'invalid', 'skipped'] as const;
export const ImportRowOutcomeSchema = z.enum(IMPORT_ROW_OUTCOMES);
export type ImportRowOutcome = z.infer<typeof ImportRowOutcomeSchema>;

/** Why a row is invalid or skipped, or what it couldn't fill. */
export const IMPORT_REASON_CODES = [
  'no_name',
  'name_too_long',
  'email_invalid',
  'phone_invalid',
  'value_too_long',
  'duplicate_in_file',
  'phone_shared',
  'email_taken',
] as const;
export const ImportReasonCodeSchema = z.enum(IMPORT_REASON_CODES);
export type ImportReasonCode = z.infer<typeof ImportReasonCodeSchema>;

/** A reason with its sentence for the owner (with the row number and what to fix). */
export const ImportReasonSchema = z.object({
  code: ImportReasonCodeSchema,
  message: z.string(),
});
export type ImportReason = z.infer<typeof ImportReasonSchema>;

/** A row as the preview shows it. */
export const ImportRowSchema = z.object({
  /** Where the owner finds it: the spreadsheet row (the header is row 1), or the item number. */
  row: z.number().int().positive(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  outcome: ImportRowOutcomeSchema,
  reasons: z.array(ImportReasonSchema),
  /** The client it matches or created. */
  clientId: ClientIdSchema.nullable(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

export const ImportCountsSchema = z.object({
  rows: z.number().int().nonnegative(),
  create: z.number().int().nonnegative(),
  merge: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
  invalid: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
});
export type ImportCounts = z.infer<typeof ImportCountsSchema>;

/**
 * Where an import is: staged (previewed, nothing written), queued and running (committed),
 * done, failed (given up after its attempts; what it wrote stays and can be undone), undone.
 */
export const IMPORT_BATCH_STATUSES = [
  'staged',
  'queued',
  'running',
  'done',
  'failed',
  'undone',
] as const;
export const ImportBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);
export type ImportBatchStatus = z.infer<typeof ImportBatchStatusSchema>;

/** What an undo did: clients removed, emails and phones cleared again, clients kept. */
export const ImportUndoSchema = z.object({
  deleted: z.number().int().nonnegative(),
  restored: z.number().int().nonnegative(),
  kept: z.number().int().nonnegative(),
});
export type ImportUndo = z.infer<typeof ImportUndoSchema>;

/** An import as the api returns it. */
export const ImportBatchSchema = z.object({
  id: ImportBatchIdSchema,
  status: ImportBatchStatusSchema,
  format: ImportFormatSchema,
  /** The tool the file was recognised as; `null` for any other file. */
  preset: ImportPresetSchema.nullable(),
  columns: z.array(ImportColumnSchema),
  /** Problems with the whole mapping, e.g. no column gives a name. */
  problems: z.array(z.string()),
  /** The preview's counts while staged; what the import did once it ran. */
  counts: ImportCountsSchema,
  createdAt: UtcDateTimeSchema,
  committedAt: UtcDateTimeSchema.nullable(),
  finishedAt: UtcDateTimeSchema.nullable(),
  undoUntil: UtcDateTimeSchema.nullable(),
  undoneAt: UtcDateTimeSchema.nullable(),
  undo: ImportUndoSchema.nullable(),
});
export type ImportBatch = z.infer<typeof ImportBatchSchema>;

/** An import with its rows: invalid and skipped first, at most IMPORT_PREVIEW_ROWS. */
export const ImportPreviewSchema = z.object({
  batch: ImportBatchSchema,
  rows: z.array(ImportRowSchema),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
