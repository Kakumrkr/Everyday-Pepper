import type { ImportField } from '@pepper/contracts';

// The columns of Pepper's own export (S51, ADR-0053): `clients.csv` and `visits.csv` are
// written with these headers, and the `pepper` preset reads them back with these fields, so a
// file Pepper wrote imports with nothing mapped by hand. One list for both keeps them equal.

export interface PepperColumn {
  /** The header as written. */
  header: string;
  /** The same header normalised as the mapping reads it (`normalizeHeader`). */
  key: string;
  field: ImportField;
}

/** `clients.csv`, one client per row. */
export const PEPPER_CLIENT_COLUMNS = [
  { header: 'pepper_client_id', key: 'pepperclientid', field: 'external_id' },
  { header: 'name', key: 'name', field: 'name' },
  { header: 'email', key: 'email', field: 'email' },
  { header: 'phone', key: 'phone', field: 'phone' },
  { header: 'birthday', key: 'birthday', field: 'birthday' },
  { header: 'tags', key: 'tags', field: 'tags' },
] as const satisfies readonly PepperColumn[];

/** `visits.csv`, one visit or appointment per row with its client. */
export const PEPPER_VISIT_COLUMNS = [
  { header: 'pepper_visit_id', key: 'peppervisitid', field: 'visit_id' },
  { header: 'date', key: 'date', field: 'visit_date' },
  { header: 'time', key: 'time', field: 'visit_time' },
  { header: 'duration_minutes', key: 'durationminutes', field: 'duration' },
  { header: 'service', key: 'service', field: 'service' },
  { header: 'staff', key: 'staff', field: 'staff' },
  { header: 'price', key: 'price', field: 'price' },
  { header: 'status', key: 'status', field: 'status' },
  { header: 'pepper_client_id', key: 'pepperclientid', field: 'external_id' },
  { header: 'client', key: 'client', field: 'name' },
  { header: 'email', key: 'email', field: 'email' },
  { header: 'phone', key: 'phone', field: 'phone' },
] as const satisfies readonly PepperColumn[];

/** A preset's columns from one of the lists. */
export function presetColumns(columns: readonly PepperColumn[]): Record<string, ImportField> {
  return Object.fromEntries(columns.map(({ key, field }) => [key, field]));
}
