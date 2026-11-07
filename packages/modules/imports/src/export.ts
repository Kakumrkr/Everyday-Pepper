import {
  BUSINESS_EXPORT_FILES,
  clockTime,
  MAX_IMPORT_ROWS,
  formatDate,
  localTimeLabel,
  toZoned,
  type BusinessExportCounts,
} from '@pepper/contracts';
import type { BusinessExportData } from '@pepper/db';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { PEPPER_CLIENT_COLUMNS, PEPPER_VISIT_COLUMNS } from './pepper-format.js';

// The business export's files (S51, ADR-0053, AC-W1-37, AC-W1-38): what `readBusinessExport`
// read, written as Pepper's own CSVs (the `pepper` preset reads them back) and JSON, and
// zipped. Pure: the service reads, audits and hands the bytes to the api.

/**
 * A cell as a spreadsheet should show it: text that a spreadsheet would run as a formula
 * (`=`, `+`, `-`, `@`, a tab or a carriage return first) gets a leading `'`, except a plain
 * number (`-5`, `4.50`) or an E.164 phone (`+15551234567`), which a spreadsheet shows as it is;
 * then quoted when it holds a comma, a quote or a line break (RFC 4180). The import drops the
 * `'` again (`parseImportFile`).
 */
export function csvCell(value: string): string {
  const risky = /^[=+\-@\t\r]/.test(value) && !/^[+-]?\d+(\.\d+)?$/.test(value);
  const safe = risky ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV with a byte-order mark (so spreadsheets read it as UTF-8) and CRLF line ends. */
export function toCsv(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [headers, ...rows].map((cells) => cells.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Cents as dollars with two decimals (`4500` → `45.00`); blank without a price. */
function dollars(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2);
}

function birthday(client: BusinessExportData['clients'][number]): string {
  const { birthdayMonth: month, birthdayDay: day, birthdayYear: year } = client;
  if (month === null || day === null) return '';
  const md = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return year === null ? `--${md}` : `${String(year)}-${md}`;
}

/** Rows split into files the import takes whole (`visits.csv`, `visits-2.csv`, …). */
function parts(base: string, rows: readonly (readonly string[])[]): [string, string[][]][] {
  const out: [string, string[][]][] = [];
  for (let start = 0; start === 0 || start < rows.length; start += MAX_IMPORT_ROWS) {
    const n = out.length + 1;
    const name = n === 1 ? `${base}.csv` : `${base}-${String(n)}.csv`;
    out.push([name, rows.slice(start, start + MAX_IMPORT_ROWS).map((row) => [...row])]);
  }
  return out;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** What the export's README says: each file, the time zone, and how to bring it back. */
function readme(data: BusinessExportData, exportedAt: Date, csvNames: readonly string[]): string {
  const lines = [
    `${data.business.name}: your data from Pepper`,
    `Exported ${exportedAt.toISOString()} (times in the files are UTC, except visits.csv).`,
    '',
    ...BUSINESS_EXPORT_FILES.map(({ name, holds }) => `${name}  ${holds}`),
    ...csvNames
      .filter((name) => !BUSINESS_EXPORT_FILES.some((file) => file.name === name))
      .map((name) => `${name}  More rows of the file before it (10,000 rows a file)`),
    '',
    // In words, as the app says it ("Eastern Time", "Paris time"; S51.2, AC-W1-44).
    `visits.csv gives each visit's date and time in ${localTimeLabel(data.business.timeZone, exportedAt.getTime())}, the business's time zone.`,
    'Prices are in dollars; in the JSON files, money is in cents.',
    'To bring your clients and visits into Pepper again: Clients → Import, clients.csv first,',
    'then visits.csv. Pepper recognises its own files, so no column needs mapping.',
    '',
  ];
  return lines.join('\r\n');
}

export interface BusinessExport {
  /** `pepper-export-<slug>-<yyyy-mm-dd>.zip`, the date in the business's time zone. */
  fileName: string;
  bytes: Uint8Array;
  counts: BusinessExportCounts;
}

/** The business's export as a ZIP (AC-W1-37). */
export function buildBusinessExport(data: BusinessExportData, exportedAt: Date): BusinessExport {
  const zone = data.business.timeZone;
  const services = new Map(data.services.map((s) => [s.id, s]));
  const staff = new Map(data.staff.map((s) => [s.id, s]));
  const clients = new Map(data.clients.map((c) => [c.id, c]));

  const clientRows = data.clients.map((client) => {
    const cells: Record<(typeof PEPPER_CLIENT_COLUMNS)[number]['header'], string> = {
      pepper_client_id: client.id,
      name: client.name,
      email: client.email ?? '',
      phone: client.phone ?? '',
      birthday: birthday(client),
      tags: client.tags.join('; '),
    };
    return PEPPER_CLIENT_COLUMNS.map(({ header }) => cells[header]);
  });
  // A deleted client was forgotten (ADR-0051): their visits stay in appointments.json with no
  // client, and are left out of visits.csv, which would import them as a new client.
  const visitRows = data.bookings.flatMap((booking) => {
    const client = clients.get(booking.clientId);
    if (client === undefined) return [];
    const local = toZoned(zone, booking.startsAt.getTime());
    const cells: Record<(typeof PEPPER_VISIT_COLUMNS)[number]['header'], string> = {
      pepper_visit_id: booking.id,
      date: formatDate(local),
      time: clockTime(local.minuteOfDay),
      duration_minutes: String(
        Math.round((booking.endsAt.getTime() - booking.startsAt.getTime()) / 60_000),
      ),
      service: services.get(booking.serviceId)?.name ?? '',
      staff: staff.get(booking.staffMemberId)?.displayName ?? '',
      price: dollars(booking.priceFromCents),
      status: booking.status,
      pepper_client_id: client.id,
      client: client.name,
      email: client.email ?? '',
      phone: client.phone ?? '',
    };
    return [PEPPER_VISIT_COLUMNS.map(({ header }) => cells[header])];
  });

  const csvFiles = [
    ...parts('clients', clientRows).map(
      ([name, rows]) =>
        [
          name,
          toCsv(
            PEPPER_CLIENT_COLUMNS.map((c) => c.header),
            rows,
          ),
        ] as const,
    ),
    ...parts('visits', visitRows).map(
      ([name, rows]) =>
        [
          name,
          toCsv(
            PEPPER_VISIT_COLUMNS.map((c) => c.header),
            rows,
          ),
        ] as const,
    ),
  ];
  const at = (date: Date) => date.toISOString();
  // Each thread's messages, in their order, grouped once (support.json, S59).
  const supportMessages = new Map<string, BusinessExportData['support']['messages']>();
  for (const message of data.support.messages) {
    const list = supportMessages.get(message.threadId) ?? [];
    list.push(message);
    supportMessages.set(message.threadId, list);
  }
  const jsonFiles: [string, string][] = [
    [
      'business.json',
      json({
        ...data.business,
        createdAt: at(data.business.createdAt),
        rules: data.rules,
      }),
    ],
    [
      'team.json',
      json(
        data.staff.map((member) => ({
          ...member,
          serviceIds: data.staffServices
            .filter((offer) => offer.staffMemberId === member.id)
            .map((offer) => offer.serviceId),
          hours: data.workingHours
            .filter((hours) => hours.staffMemberId === member.id)
            .map(({ weekday, startMinute, endMinute }) => ({
              weekday,
              start: clockTime(startMinute),
              end: clockTime(endMinute),
            })),
          timeOff: data.timeOff
            .filter((away) => away.staffMemberId === member.id)
            .map((away) => ({ startsAt: at(away.startsAt), endsAt: at(away.endsAt) })),
        })),
      ),
    ],
    ['services.json', json(data.services)],
    [
      'clients.json',
      json(
        data.clients.map((client) => ({
          ...client,
          emailOptOutAt: client.emailOptOutAt === null ? null : at(client.emailOptOutAt),
          createdAt: at(client.createdAt),
        })),
      ),
    ],
    [
      'appointments.json',
      json(
        data.bookings.map((booking) => ({
          ...booking,
          clientId: clients.has(booking.clientId) ? booking.clientId : null,
          startsAt: at(booking.startsAt),
          endsAt: at(booking.endsAt),
          createdAt: at(booking.createdAt),
        })),
      ),
    ],
    [
      'waitlist.json',
      json(
        data.waitlist.map((entry) => ({
          ...entry,
          expiresAt: at(entry.expiresAt),
          createdAt: at(entry.createdAt),
        })),
      ),
    ],
    [
      'pepper-knows.json',
      json(
        data.facts.map((fact) => ({
          ...fact,
          createdAt: at(fact.createdAt),
          updatedAt: at(fact.updatedAt),
        })),
      ),
    ],
    [
      'support.json',
      json(
        data.support.threads.map((thread) => ({
          reference: thread.reference,
          kind: thread.kind,
          status: thread.status,
          openedAt: at(thread.createdAt),
          messages: (supportMessages.get(thread.id) ?? []).map((message) => ({
            from: message.authorKind === 'pepper' ? 'Pepper team' : 'Your team',
            text: message.body,
            at: at(message.createdAt),
          })),
        })),
      ),
    ],
  ];

  const files: Zippable = {};
  const add = (name: string, text: string) => {
    files[name] = [strToU8(text), { mtime: exportedAt }];
  };
  add(
    'README.txt',
    readme(
      data,
      exportedAt,
      csvFiles.map(([name]) => name),
    ),
  );
  for (const [name, text] of csvFiles) add(name, text);
  for (const [name, text] of jsonFiles) add(name, text);

  const day = formatDate(toZoned(zone, exportedAt.getTime()));
  return {
    fileName: `pepper-export-${data.business.slug}-${day}.zip`,
    bytes: zipSync(files, { level: 6 }),
    counts: {
      clients: data.clients.length,
      visits: data.bookings.length,
      services: data.services.length,
      staff: data.staff.length,
      waitlist: data.waitlist.length,
      facts: data.facts.length,
    },
  };
}
