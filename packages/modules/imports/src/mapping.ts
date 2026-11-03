import {
  ClientEmailSchema,
  normalizePhone,
  PhoneSchema,
  VISIT_IMPORT_FIELDS,
  type ImportColumn,
  type ImportField,
  type ImportKind,
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
// A visits file (S49, ADR-0050: one row per appointment) has presets of its own; a visit
// field is suggested only for a file with a date and a service or staff column, so a client
// file's "Date Added" doesn't turn it into a visits file.

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
      birthday: 'birthday',
      memo: later('notes'),
      groups: 'tags',
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
      birthday: 'birthday',
      notes: later('notes'),
      tags: 'tags',
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
      birthday: 'birthday',
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
      birthday: 'birthday',
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
      dateofbirth: 'birthday',
      notes: later('notes'),
      gender: null,
      clientsource: null,
      added: null,
      blocked: null,
    },
  },
};

/**
 * Each tool's appointments export (S49), by normalised header. They share the tool's client
 * export's `system`, so the client ids in both meet.
 */
export const VISIT_PRESETS: Readonly<Record<ImportPreset, Preset>> = {
  square: {
    signature: ['appointmentid', 'teammember', 'customername'],
    columns: {
      appointmentid: 'visit_id',
      date: 'visit_date',
      time: 'visit_time',
      durationminutes: 'duration',
      customerid: 'external_id',
      customername: 'name',
      customeremail: 'email',
      customerphone: 'phone',
      service: 'service',
      teammember: 'staff',
      status: 'status',
      price: 'price',
    },
  },
  booksy: {
    signature: ['bookingid', 'staffer'],
    columns: {
      bookingid: 'visit_id',
      appointmentdate: 'visit_date',
      starttime: 'visit_time',
      endtime: 'visit_end',
      customerid: 'external_id',
      customername: 'name',
      email: 'email',
      mobile: 'phone',
      service: 'service',
      staffer: 'staff',
      status: 'status',
      price: 'price',
    },
  },
  vagaro: {
    signature: ['appointmentdate', 'serviceprovider'],
    columns: {
      appointmentdate: 'visit_date',
      starttime: 'visit_time',
      endtime: 'visit_end',
      firstname: 'first_name',
      lastname: 'last_name',
      email: 'email',
      cellphone: 'phone',
      service: 'service',
      serviceprovider: 'staff',
      status: 'status',
      amount: 'price',
    },
  },
  glossgenius: {
    signature: ['servicename', 'appointmentstatus'],
    columns: {
      appointmentdate: 'visit_date',
      clientname: 'name',
      email: 'email',
      phone: 'phone',
      servicename: 'service',
      teammember: 'staff',
      duration: 'duration',
      price: 'price',
      appointmentstatus: 'status',
    },
  },
  fresha: {
    signature: ['ref', 'scheduleddate'],
    columns: {
      ref: 'visit_id',
      scheduleddate: 'visit_date',
      time: 'visit_time',
      duration: 'duration',
      clientid: 'external_id',
      client: 'name',
      mobilenumber: 'phone',
      email: 'email',
      service: 'service',
      teammember: 'staff',
      status: 'status',
      price: 'price',
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
  ['birthday', ['birthday', 'birthdate', 'dateofbirth', 'dob', 'bday']],
  [later('notes'), ['notes', 'note', 'memo', 'comments', 'comment', 'clientnotes']],
  ['tags', ['tags', 'tag', 'labels', 'groups', 'clienttags', 'customertags']],
  [
    'visit_date',
    [
      'date',
      'appointmentdate',
      'visitdate',
      'bookingdate',
      'scheduleddate',
      'startdate',
      'datetime',
      'startdatetime',
      'start',
      'startsat',
      'startat',
      'appointmentstart',
      'scheduledat',
    ],
  ],
  ['visit_time', ['time', 'starttime', 'appointmenttime', 'visittime', 'bookingtime', 'from']],
  ['visit_end', ['endtime', 'end', 'endsat', 'endat', 'finish', 'finishtime', 'enddatetime']],
  ['duration', ['duration', 'durationminutes', 'durationmins', 'length', 'minutes', 'mins']],
  [
    'service',
    ['service', 'servicename', 'services', 'treatment', 'appointmenttype', 'servicetype'],
  ],
  [
    'staff',
    [
      'staff',
      'staffname',
      'staffmember',
      'teammember',
      'provider',
      'serviceprovider',
      'employee',
      'stylist',
      'barber',
      'artist',
      'technician',
      'staffer',
      'professional',
    ],
  ],
  ['price', ['price', 'amount', 'total', 'servicetotal', 'cost', 'charged', 'paid']],
  ['status', ['status', 'appointmentstatus', 'bookingstatus', 'visitstatus', 'state']],
  [
    'visit_id',
    ['appointmentid', 'bookingid', 'visitid', 'appointmentref', 'bookingref', 'ref', 'reference'],
  ],
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

/** The tool whose export has these columns, if any, and whether it's its appointments export. */
export function detectPreset(
  columns: readonly string[],
): { preset: ImportPreset; visits: boolean } | null {
  const headers = new Set(columns.map(normalizeHeader));
  const find = (presets: Readonly<Record<ImportPreset, Preset>>) =>
    (Object.entries(presets) as [ImportPreset, Preset][]).find(([, { signature }]) =>
      signature.every((header) => headers.has(header)),
    )?.[0];
  const visits = find(VISIT_PRESETS);
  if (visits !== undefined) return { preset: visits, visits: true };
  const clients = find(PRESETS);
  return clients === undefined ? null : { preset: clients, visits: false };
}

/** Fields only one column may fill. */
const SINGLE: ReadonlySet<ImportField> = new Set([
  'name',
  'first_name',
  'last_name',
  'external_id',
  'birthday',
  ...VISIT_IMPORT_FIELDS,
]);
const VISIT_FIELDS: ReadonlySet<ImportField> = new Set(VISIT_IMPORT_FIELDS);

/** How many values a column's pattern is judged on, and the share that must fit. */
const SAMPLE = 50;
const SHARE = 0.8;

/** The suggested mapping of a file's columns (AC-W1-17). */
export function suggestMapping(table: Table): {
  preset: ImportPreset | null;
  columns: ImportColumn[];
} {
  const detected = detectPreset(table.columns);
  const preset = detected?.preset ?? null;
  const presetColumns =
    detected === null ? {} : (detected.visits ? VISIT_PRESETS : PRESETS)[detected.preset].columns;
  const headers = table.columns.map(normalizeHeader);
  // Visit fields only for a file that looks like visits: a date, and a service or staff column.
  const looksLikeVisits =
    detected?.visits ??
    (headers.some((h) => byHeader(h) === 'visit_date') &&
      headers.some((h) => {
        const target = byHeader(h);
        return target === 'service' || target === 'staff';
      }));
  const taken = new Set<ImportField>();
  const columns = table.columns.map((column, index): ImportColumn => {
    const header = normalizeHeader(column);
    // A column the tool's preset names, even as "not imported", is decided by the preset.
    const inPreset = Object.hasOwn(presetColumns, header);
    let target: Target = inPreset ? (presetColumns[header] ?? null) : byHeader(header);
    // In a visits file, a bare "ID" is the appointment's, not the client's.
    if (!inPreset && looksLikeVisits && target === 'external_id' && header === 'id') {
      target = 'visit_id';
    }
    if (typeof target === 'string' && VISIT_FIELDS.has(target) && !looksLikeVisits) {
      target = null;
    }
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

/** A client file, or a visits file when a column gives the visit's date (S49). */
export function kindOf(mapping: ImportMapping): ImportKind {
  return mapping.some(({ field }) => field === 'visit_date') ? 'visits' : 'clients';
}

/** What's wrong with a mapping as a whole: the sentences shown above the preview. */
export function mappingProblems(mapping: ImportMapping): string[] {
  const fields = new Set(mapping.map(({ field }) => field));
  const problems: string[] = [];
  if (!fields.has('name') && !fields.has('first_name') && !fields.has('last_name')) {
    problems.push('Choose the column with the client’s name.');
  }
  const visitFields = [...fields].filter(
    (field): field is ImportField => field !== null && VISIT_FIELDS.has(field),
  );
  if (visitFields.length > 0 && !fields.has('visit_date')) {
    problems.push('Choose the column with the visit’s date, or don’t import the visit columns.');
  }
  return problems;
}
