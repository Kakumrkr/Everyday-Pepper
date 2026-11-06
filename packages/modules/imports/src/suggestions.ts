import {
  IMPORT_FIELDS,
  IMPORT_SUGGESTION_LIMITS,
  SINGLE_IMPORT_FIELDS,
  VISIT_IMPORT_FIELDS,
  type ImportColumn,
  type ImportField,
  type ImportKind,
  type ImportMappingAnswer,
  type ImportMappingQuestion,
} from '@pepper/contracts';
import type { Table } from './parse.js';

// AI-suggested mapping (S56a.2, ADR-0061, AC-W1-46/47): for the columns nothing else placed,
// the model is asked with the column names and a few samples masked to their shape, and its
// answer is a suggestion the owner may use, column by column. The domain chooses what is asked
// and checks every answer: the model never maps a column itself.

/** How many cells are read for a column's samples. */
const SCAN = 50;

/**
 * A value reduced to its shape: capitals become `A`, other letters `a`, digits `9`; spaces and
 * punctuation stay ("Ana López" → "Aaa Aaaaa", "(555) 010-2030" → "(999) 999-9999"), so the
 * model can tell a phone from a date without seeing either. At most 40 characters.
 */
export function maskSample(value: string): string {
  const masked = value.trim().replace(/[\p{L}\p{N}\p{M}\s]/gu, (char) => {
    if (/\p{Lu}/u.test(char)) return 'A';
    if (/\p{L}/u.test(char)) return 'a';
    if (/\p{N}/u.test(char)) return '9';
    // A combining mark (the accent of a decomposed "é") says nothing more.
    if (/\p{M}/u.test(char)) return '';
    return ' ';
  });
  return Array.from(masked).slice(0, IMPORT_SUGGESTION_LIMITS.sampleLength).join('');
}

/** A column nothing placed: no field, nothing Pepper recognised, not decided by the owner. */
export function isUnplaced(column: ImportColumn): boolean {
  return column.field === null && column.later === null && column.by === null;
}

/** The columns still to ask about: unplaced and never asked. */
function toAsk(columns: readonly ImportColumn[]): ImportColumn[] {
  return columns
    .filter((column) => isUnplaced(column) && column.suggestion === null)
    .slice(0, IMPORT_SUGGESTION_LIMITS.columns);
}

/** The fields an unplaced column may still fill, given the mapping so far. */
export function openFields(columns: readonly ImportColumn[]): ImportField[] {
  const filled = new Set(columns.flatMap(({ field }) => (field === null ? [] : [field])));
  return IMPORT_FIELDS.filter((field) => {
    if (SINGLE_IMPORT_FIELDS.includes(field) && filled.has(field)) return false;
    // A full name and first/last names don't go together (the full name wins).
    if ((field === 'first_name' || field === 'last_name') && filled.has('name')) return false;
    if (field === 'name' && (filled.has('first_name') || filled.has('last_name'))) return false;
    return true;
  });
}

/** The question for a staged file, or `null` when every column is placed or was asked. */
export function mappingQuestion(
  table: Table,
  columns: readonly ImportColumn[],
  kind: ImportKind,
): ImportMappingQuestion | null {
  const asked = toAsk(columns);
  const fields = openFields(columns);
  if (asked.length === 0 || fields.length === 0) return null;
  return {
    kind,
    columns: asked.map(({ column }) => {
      const index = table.columns.indexOf(column);
      const samples = new Set<string>();
      for (const { cells } of table.rows.slice(0, SCAN)) {
        const value = index < 0 ? '' : (cells[index] ?? '').trim();
        if (value !== '') samples.add(maskSample(value));
        if (samples.size === IMPORT_SUGGESTION_LIMITS.samples) break;
      }
      return { column, samples: [...samples] };
    }),
    fields,
  };
}

const VISIT_FIELDS: ReadonlySet<ImportField> = new Set(VISIT_IMPORT_FIELDS);

/**
 * The columns with the model's answer checked and stored as suggestions (AC-W1-47). A
 * suggestion is kept only for a column that was asked about and is still unplaced, with a field
 * still open; a field only one column may fill goes to the first column suggested for it; visit
 * fields only when the file then has a visit date. Every column asked about is marked as asked
 * (`{ field: null }` when nothing fits), so it isn't asked again. Nothing is mapped.
 */
export function acceptSuggestions(
  columns: readonly ImportColumn[],
  question: ImportMappingQuestion,
  answer: ImportMappingAnswer,
): ImportColumn[] {
  const asked = new Set(question.columns.map(({ column }) => column));
  const open = new Set(openFields(columns));
  const chosen = new Map<string, ImportField>();
  const taken = new Set<ImportField>();
  for (const { column, field } of answer.columns) {
    if (!asked.has(column) || chosen.has(column) || field === null || !open.has(field)) continue;
    if (SINGLE_IMPORT_FIELDS.includes(field)) {
      if (taken.has(field)) continue;
      taken.add(field);
    }
    chosen.set(column, field);
  }
  const hasDate =
    columns.some(({ field }) => field === 'visit_date') ||
    [...chosen.values()].includes('visit_date');
  if (!hasDate) {
    for (const [column, field] of chosen) if (VISIT_FIELDS.has(field)) chosen.delete(column);
  }
  const suggested = new Set(chosen.values());
  if (suggested.has('name')) {
    for (const [column, field] of chosen) {
      if (field === 'first_name' || field === 'last_name') chosen.delete(column);
    }
  }
  return columns.map((column) => {
    if (!asked.has(column.column) || !isUnplaced(column)) return column;
    return { ...column, suggestion: { field: chosen.get(column.column) ?? null } };
  });
}
