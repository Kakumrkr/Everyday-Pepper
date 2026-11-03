import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_COLUMN_LENGTH,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type ImportFormat,
} from '@pepper/contracts';
import { parse as parseCsv } from 'csv-parse/sync';

// Reading an uploaded client file (S48, ADR-0049) into one table of text: its columns and, for
// each row, its cells in column order. The file is untrusted: its size, row and column counts
// are bounded, nothing in it is evaluated, and what it says is never logged.

/** A row of the file: where the owner finds it and its cells, one per column. */
export interface TableRow {
  /** The spreadsheet row (the header is row 1), the JSON item number or the JSONL line. */
  row: number;
  cells: string[];
}

export interface Table {
  format: ImportFormat;
  columns: string[];
  rows: TableRow[];
}

export type ImportFileProblem =
  'too_large' | 'empty' | 'unreadable' | 'too_many_rows' | 'too_many_columns';

/** A file that can't be imported, with a sentence for the owner. */
export class ImportFileError extends Error {
  override readonly name = 'ImportFileError';
  constructor(
    readonly problem: ImportFileProblem,
    message: string,
  ) {
    super(message);
  }
}

const TOO_MANY_ROWS = new ImportFileError(
  'too_many_rows',
  `The file has more than ${MAX_IMPORT_ROWS.toLocaleString('en-US')} clients. Split it into smaller files.`,
);
const TOO_MANY_COLUMNS = new ImportFileError(
  'too_many_columns',
  `The file has more than ${String(MAX_IMPORT_COLUMNS)} columns. Export only the client details.`,
);
const EMPTY = new ImportFileError('empty', 'The file has no clients in it.');

/** The deepest a JSON record is flattened (`contact.email` is depth 2). */
const MAX_DEPTH = 5;

/**
 * Reads a client file: UTF-8 (a byte-order mark is dropped), or Windows-1252 when it isn't
 * valid UTF-8 (Excel's CSV on Windows). Without `format`, a file starting with `[` or `{` is
 * JSON (or JSONL, one record per line), anything else CSV.
 */
export function parseImportFile(bytes: Uint8Array, format?: ImportFormat): Table {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportFileError('too_large', 'The file is larger than 5 MB.');
  }
  const text = decode(bytes);
  if (text.trim() === '') throw EMPTY;
  const chosen = format ?? detectFormat(text);
  const table = chosen === 'csv' ? readCsv(text) : readJson(text, chosen);
  if (table.rows.length === 0) throw EMPTY;
  return table;
}

function decode(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  return text.startsWith('﻿') ? text.slice(1) : text;
}

function detectFormat(text: string): ImportFormat {
  const start = text.trimStart();
  if (start.startsWith('[')) return 'json';
  if (!start.startsWith('{')) return 'csv';
  try {
    JSON.parse(start);
    return 'json';
  } catch {
    return 'jsonl';
  }
}

/** The delimiter the header line uses most: comma, semicolon or tab. */
function detectDelimiter(text: string): string {
  const header = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let most = 0;
  for (const candidate of [',', ';', '\t']) {
    const count = header.split(candidate).length - 1;
    if (count > most) {
      best = candidate;
      most = count;
    }
  }
  return best;
}

function readCsv(text: string): Table {
  let records: string[][];
  try {
    records = parseCsv(text, {
      delimiter: detectDelimiter(text),
      relax_column_count: true,
      relax_quotes: true,
      // Blank lines stay records (dropped below), so row numbers match the spreadsheet's.
      trim: true,
      max_record_size: 100_000,
    });
  } catch {
    throw new ImportFileError(
      'unreadable',
      'Pepper couldn’t read this file as CSV. Export it again as CSV, JSON or JSONL.',
    );
  }
  const blank = (record: string[]) => record.every((cell) => cell === '');
  const start = records.findIndex((record) => !blank(record));
  const header = records[start];
  if (header === undefined) throw EMPTY;
  const body = records.slice(start + 1);
  const columns = columnNames(header);
  const rows: TableRow[] = [];
  body.forEach((record, index) => {
    if (blank(record)) return;
    rows.push({ row: start + index + 2, cells: columns.map((_, i) => record[i] ?? '') });
  });
  // The whole file is read (5 MB at most), so blank lines don't count towards the limit.
  if (rows.length > MAX_IMPORT_ROWS) throw TOO_MANY_ROWS;
  return { format: 'csv', columns, rows };
}

/** Header cells as column names: blanks named by position, repeats numbered, long ones cut. */
function columnNames(header: readonly string[]): string[] {
  if (header.length > MAX_IMPORT_COLUMNS) throw TOO_MANY_COLUMNS;
  const seen = new Set<string>();
  return header.map((cell, index) => {
    const base = (cell.trim() || `Column ${String(index + 1)}`).slice(
      0,
      MAX_IMPORT_COLUMN_LENGTH - 5,
    );
    let name = base;
    for (let n = 2; seen.has(name); n += 1) name = `${base} (${String(n)})`;
    seen.add(name);
    return name;
  });
}

function readJson(text: string, format: 'json' | 'jsonl'): Table {
  const records = format === 'json' ? jsonRecords(text) : jsonlRecords(text);
  if (records.length > MAX_IMPORT_ROWS) throw TOO_MANY_ROWS;
  const flat = records.map(({ row, value }) => ({ row, value: flatten(value) }));
  const order: string[] = [];
  const known = new Set<string>();
  for (const { value } of flat) {
    for (const key of value.keys()) {
      if (known.has(key)) continue;
      known.add(key);
      order.push(key);
      if (order.length > MAX_IMPORT_COLUMNS) throw TOO_MANY_COLUMNS;
    }
  }
  const columns = columnNames(order);
  const rows = flat
    .map(({ row, value }) => ({ row, cells: order.map((key) => value.get(key) ?? '') }))
    .filter(({ cells }) => cells.some((cell) => cell !== ''));
  return { format, columns, rows };
}

const notJson = (format: string) =>
  new ImportFileError(
    'unreadable',
    `Pepper couldn’t read this file as ${format}. Export it again as CSV, JSON or JSONL.`,
  );

/** A JSON file's records: an array of objects, or the first array of objects in an object. */
function jsonRecords(text: string): { row: number; value: Record<string, unknown> }[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw notJson('JSON');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed)
      ? Object.values(parsed).find((value) => Array.isArray(value) && value.some(isRecord))
      : undefined;
  if (!Array.isArray(list)) throw notJson('JSON');
  return list.map((value, index) => {
    if (!isRecord(value)) {
      throw new ImportFileError(
        'unreadable',
        `Item ${String(index + 1)} of the file isn’t a client record.`,
      );
    }
    return { row: index + 1, value };
  });
}

function jsonlRecords(text: string): { row: number; value: Record<string, unknown> }[] {
  const records: { row: number; value: Record<string, unknown> }[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    if (records.length >= MAX_IMPORT_ROWS) throw TOO_MANY_ROWS;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ImportFileError(
        'unreadable',
        `Line ${String(index + 1)} of the file isn’t valid JSON.`,
      );
    }
    if (!isRecord(value)) {
      throw new ImportFileError(
        'unreadable',
        `Line ${String(index + 1)} of the file isn’t a client record.`,
      );
    }
    records.push({ row: index + 1, value });
  }
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A record as text cells: nested objects become `parent.child` columns (to MAX_DEPTH), lists of
 * plain values one cell joined by ", ", anything deeper its JSON.
 */
function flatten(record: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (value: unknown, key: string, depth: number) => {
    if (isRecord(value) && depth < MAX_DEPTH) {
      for (const [child, inner] of Object.entries(value)) {
        visit(inner, key === '' ? child : `${key}.${child}`, depth + 1);
      }
      return;
    }
    out.set(key, cellText(value));
  };
  visit(record, '', 0);
  return out;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')) {
    return value
      .map(cellText)
      .filter((item) => item !== '')
      .join(', ');
  }
  return JSON.stringify(value);
}
