import {
  ClientEmailSchema,
  normalizePhone,
  PhoneSchema,
  type ImportColumn,
  type ImportField,
  type ImportLaterField,
  type ImportMapping,
  type ImportPreset,
} from '@pepper/contracts';
import type { Table } from './parse.js';

// How a client file's columns map onto a client (S48, ADR-0049, AC-W1-17): a known tool's
// export is recognised by its headers and mapped by its preset; other columns by their header
// names, then by their values (a column of emails, a column of phones). The owner confirms or
// changes the mapping; nothing here guesses a name from values.
//
// The presets are written from the tools' documented export columns as far as they are public;
// fixtures in `src/fixtures` hold made-up rows in each layout. Header matching ignores case,
// spaces and punctuation, and anything a preset misses still goes through the smart mapping.

type Target = ImportField | { later: ImportLaterField } | null;

interface Preset {
  /** Headers that, all present, mark the tool's export. */
  signature: readonly string[];
  columns: Readonly<Record<string, Target>>;
}

const later = (field: ImportLaterField) => ({ later: field });

/** Each tool's client export, by normalised header (lowercase letters and digits only). */
export const PRESETS: Readonly<Record<ImportPreset, Preset>> = {
  square: {
    signature: ['squarecustomerid'],
    columns: {
      squarecustomerid: 'external_id',
      firstname: 'first_name',
      lastname: 'last_name',
      emailaddress: 'email',
      phonenumber: 'phone',
      referenceid: null,
      nickname: null,
      companyname: null,
      birthday: later('birthday'),
      memo: later('notes'),
      groups: later('tags'),
      firstvisit: later('visits'),
      lastvisit: later('visits'),
      transactioncount: later('visits'),
    },
  },
  booksy: {
    signature: ['customerid', 'mobile', 'lastvisitdate'],
    columns: {
      customerid: 'external_id',
      firstname: 'first_name',
      lastname: 'last_name',
      email: 'email',
      mobile: 'phone',
      birthday: later('birthday'),
      notes: later('notes'),
      tags: later('tags'),
      lastvisitdate: later('visits'),
    },
  },
  vagaro: {
    signature: ['cellphone', 'customersince'],
    columns: {
      firstname: 'first_name',
      lastname: 'last_name',
      email: 'email',
      cellphone: 'phone',
      dayphone: 'phone',
      nightphone: 'phone',
      birthday: later('birthday'),
      customersince: later('visits'),
      lastvisit: later('visits'),
      notes: later('notes'),
    },
  },
  glossgenius: {
    signature: ['clientname', 'totalspend'],
    columns: {
      clientname: 'name',
      email: 'email',
      phone: 'phone',
      birthday: later('birthday'),
      notes: later('notes'),
      lastappointmentdate: later('visits'),
      totalspend: later('visits'),
    },
  },
  fresha: {
    signature: ['mobilenumber', 'clientsource'],
    columns: {
      clientid: 'external_id',
      firstname: 'first_name',
      lastname: 'last_name',
      mobilenumber: 'phone',
      telephone: 'phone',
      email: 'email',
      dateofbirth: later('birthday'),
      notes: later('notes'),
      gender: null,
      clientsource: null,
      added: null,
      blocked: null,
    },
  },
};

/** Header names (normalised) that say what a column holds, for any file. */
const HEADERS: readonly [Target, readonly string[]][] = [
  [
    'name',
    [
      'name',
      'fullname',
      'clientname',
      'customername',
      'client',
      'customer',
      'displayname',
      'contactname',
    ],
  ],
  ['first_name', ['firstname', 'first', 'givenname', 'fname', 'forename']],
  ['last_name', ['lastname', 'last', 'surname', 'familyname', 'lname']],
  ['email', ['email', 'emailaddress', 'mail', 'emailid']],
  [
    'phone',
    [
      'phone',
      'phonenumber',
      'mobile',
      'mobilenumber',
      'mobilephone',
      'cell',
      'cellphone',
      'cellnumber',
      'telephone',
      'tel',
      'homephone',
      'workphone',
      'contactnumber',
      'primaryphone',
    ],
  ],
  ['external_id', ['id', 'clientid', 'customerid', 'externalid', 'recordid', 'uuid']],
  [later('birthday'), ['birthday', 'birthdate', 'dateofbirth', 'dob', 'bday']],
  [later('notes'), ['notes', 'note', 'memo', 'comments', 'comment', 'clientnotes']],
  [later('tags'), ['tags', 'tag', 'labels', 'groups']],
  [
    later('visits'),
    ['lastvisit', 'firstvisit', 'lastappointment', 'visits', 'totalvisits', 'customersince'],
  ],
];

/** Endings of nested or prefixed headers (`contact.email`, `primary_phone_number`). */
const ENDINGS: readonly [ImportField, readonly string[]][] = [
  ['email', ['email', 'emailaddress']],
  ['phone', ['phone', 'phonenumber', 'mobile', 'cellphone']],
  ['first_name', ['firstname']],
  ['last_name', ['lastname']],
];

/** A header without case, spaces or punctuation: "E-mail Address" → "emailaddress". */
export function normalizeHeader(header: string): string {
  return header
    .toLowerCase()
    .replace(/e-mail/g, 'email')
    .replace(/[^a-z0-9]/g, '');
}

/** The tool whose export has these columns, if any. */
export function detectPreset(columns: readonly string[]): ImportPreset | null {
  const headers = new Set(columns.map(normalizeHeader));
  for (const [preset, { signature }] of Object.entries(PRESETS) as [ImportPreset, Preset][]) {
    if (signature.every((header) => headers.has(header))) return preset;
  }
  return null;
}

/** Fields only one column may fill. */
const SINGLE: ReadonlySet<ImportField> = new Set([
  'name',
  'first_name',
  'last_name',
  'external_id',
]);

/** How many values a column's pattern is judged on, and the share that must fit. */
const SAMPLE = 50;
const SHARE = 0.8;

/** The suggested mapping of a file's columns (AC-W1-17). */
export function suggestMapping(table: Table): {
  preset: ImportPreset | null;
  columns: ImportColumn[];
} {
  const preset = detectPreset(table.columns);
  const presetColumns = preset === null ? {} : PRESETS[preset].columns;
  const taken = new Set<ImportField>();
  const columns = table.columns.map((column, index): ImportColumn => {
    const header = normalizeHeader(column);
    // A column the tool's preset names, even as "not imported", is decided by the preset.
    const inPreset = Object.hasOwn(presetColumns, header);
    let target: Target = inPreset ? (presetColumns[header] ?? null) : byHeader(header);
    let by: ImportColumn['by'] = target === null ? null : inPreset ? 'preset' : 'header';
    if (target === null && !inPreset) {
      target = byValues(table, index);
      by = target === null ? null : 'values';
    }
    if (target !== null && typeof target === 'object') {
      return { column, field: null, by, later: target.later };
    }
    if (target !== null && SINGLE.has(target) && taken.has(target)) target = null;
    if (target !== null) taken.add(target);
    return { column, field: target, by: target === null ? null : by, later: null };
  });
  return { preset, columns: tidyNames(columns) };
}

function byHeader(header: string): Target {
  for (const [target, names] of HEADERS) if (names.includes(header)) return target;
  for (const [field, endings] of ENDINGS) {
    if (endings.some((ending) => header.endsWith(ending))) return field;
  }
  return null;
}

function byValues(table: Table, index: number): ImportField | null {
  const values: string[] = [];
  for (const { cells } of table.rows) {
    const value = cells[index] ?? '';
    if (value !== '') values.push(value);
    if (values.length === SAMPLE) break;
  }
  if (values.length === 0) return null;
  const share = (test: (value: string) => boolean) =>
    values.filter(test).length / values.length >= SHARE;
  if (share((value) => ClientEmailSchema.safeParse(value).success)) return 'email';
  if (share(looksLikePhone)) return 'phone';
  return null;
}

/** Phone characters only, 10 to 15 digits, and a valid number once normalised. */
function looksLikePhone(value: string): boolean {
  if (!/^[+\d\s().-]+$/.test(value)) return false;
  const digits = value.replace(/\D/g, '').length;
  return digits >= 10 && digits <= 15 && PhoneSchema.safeParse(normalizePhone(value)).success;
}

/** With a full name column, first and last name columns aren't used for the name. */
function tidyNames(columns: ImportColumn[]): ImportColumn[] {
  if (!columns.some((column) => column.field === 'name')) return columns;
  return columns.map((column) =>
    column.field === 'first_name' || column.field === 'last_name'
      ? { ...column, field: null, by: null }
      : column,
  );
}

/** The mapping as `ImportMappingSchema` takes it. */
export function mappingOf(columns: readonly ImportColumn[]): ImportMapping {
  return columns.map(({ column, field }) => ({ column, field }));
}

/** What's wrong with a mapping as a whole: the sentences shown above the preview. */
export function mappingProblems(mapping: ImportMapping): string[] {
  const fields = new Set(mapping.map(({ field }) => field));
  if (fields.has('name') || fields.has('first_name') || fields.has('last_name')) return [];
  return ['Choose the column with the client’s name.'];
}
