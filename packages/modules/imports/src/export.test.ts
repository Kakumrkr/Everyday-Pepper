import { BUSINESS_EXPORT_FILES, MAX_IMPORT_ROWS } from '@pepper/contracts';
import type { BusinessExportData } from '@pepper/db';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildBusinessExport, csvCell, toCsv } from './export.js';
import { suggestMapping } from './mapping.js';
import { parseImportFile } from './parse.js';

// The business export's files (S51, ADR-0053, AC-W1-37, AC-W1-38): safe CSV cells, every file
// in the ZIP, and Pepper's own CSVs recognised by the import with every column mapped.

const AT = new Date('2099-03-10T18:00:00Z');
const CLIENT = '0190a000-0000-7000-8000-000000000001';
const GONE = '0190a000-0000-7000-8000-000000000002';
const SERVICE = '0190a000-0000-7000-8000-000000000010';
const STAFF = '0190a000-0000-7000-8000-000000000020';

function booking(id: string, clientId: string, startsAt: string, status: string) {
  const start = new Date(startsAt);
  return {
    id,
    clientId,
    serviceId: SERVICE,
    staffMemberId: STAFF,
    startsAt: start,
    endsAt: new Date(start.getTime() + 45 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 10,
    priceFromCents: 4500,
    priceToCents: null,
    status,
    source: 'team',
    createdAt: AT,
  };
}

function data(overrides: Partial<BusinessExportData> = {}): BusinessExportData {
  return {
    business: {
      name: 'Fade, & Co',
      slug: 'fade-co',
      timeZone: 'America/Chicago',
      locale: 'en-US',
      templateId: 'barber',
      brandColor: null,
      phone: null,
      publicAddress: null,
      cancellationPolicy: null,
      mailingAddress: null,
      reviewUrl: null,
      createdAt: AT,
    },
    rules: [],
    services: [
      {
        id: SERVICE,
        name: 'Skin fade',
        category: null,
        durationMinutes: 45,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 10,
        priceFromCents: 4500,
        priceToCents: null,
        rebookAfterDays: 21,
        active: true,
      },
    ],
    staff: [{ id: STAFF, displayName: 'Jess', color: '#336699', active: true }],
    staffServices: [{ staffMemberId: STAFF, serviceId: SERVICE }],
    workingHours: [{ staffMemberId: STAFF, weekday: 2, startMinute: 540, endMinute: 1020 }],
    timeOff: [],
    clients: [
      {
        id: CLIENT,
        name: 'Dee "DJ" Hart',
        email: 'dee@example.test',
        phone: '+15551234567',
        source: 'team',
        emailOptOutAt: null,
        tags: ['vip', 'beard'],
        birthdayMonth: 4,
        birthdayDay: 12,
        birthdayYear: null,
        createdAt: AT,
      },
    ],
    bookings: [
      booking('0190a000-0000-7000-8000-000000000100', CLIENT, '2099-03-03T15:00:00Z', 'completed'),
      booking('0190a000-0000-7000-8000-000000000101', GONE, '2099-03-04T15:00:00Z', 'completed'),
    ],
    waitlist: [],
    facts: [],
    support: { threads: [], messages: [] },
    ...overrides,
  };
}

function unzip(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(
    Object.entries(unzipSync(bytes)).map(([name, content]) => [
      name,
      // Keep the byte-order mark, which a default decoder drops.
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(content),
    ]),
  );
}

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('Fade, & Co')).toBe('"Fade, & Co"');
    expect(csvCell('Dee "DJ" Hart')).toBe('"Dee ""DJ"" Hart"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('writes text a spreadsheet would run as a formula as text', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvCell('-2+3+cmd|x')).toBe("'-2+3+cmd|x");
    expect(csvCell('@foo')).toBe("'@foo");
    expect(csvCell('\tx')).toBe("'\tx");
  });

  it('leaves phones and plain numbers as they are', () => {
    expect(csvCell('+15551234567')).toBe('+15551234567');
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('4.50')).toBe('4.50');
  });

  it('guards dates and phones a spreadsheet would calculate', () => {
    expect(csvCell('--04-12')).toBe("'--04-12");
    expect(csvCell('+1-555-123-4567')).toBe("'+1-555-123-4567");
  });

  it('starts with a byte-order mark and ends every line with CRLF', () => {
    expect(toCsv(['a', 'b'], [['1', '2']])).toBe('\uFEFFa,b\r\n1,2\r\n');
  });
});

describe('buildBusinessExport (AC-W1-37)', () => {
  it('zips every file, names it by the business and its day, and counts what it holds', () => {
    const built = buildBusinessExport(data(), AT);
    expect(built.fileName).toBe('pepper-export-fade-co-2099-03-10.zip');
    expect(Object.keys(unzip(built.bytes))).toEqual(BUSINESS_EXPORT_FILES.map((f) => f.name));
    expect(built.counts).toEqual({
      clients: 1,
      visits: 2,
      services: 1,
      staff: 1,
      waitlist: 0,
      facts: 0,
    });
  });

  it('writes support.json: each request with its messages, the team’s marked (AC-X-18)', () => {
    const thread = '0190a000-0000-7000-8000-000000000900';
    const files = unzip(
      buildBusinessExport(
        data({
          support: {
            threads: [
              {
                id: thread,
                reference: 'PEP-7K3Q9D',
                kind: 'question',
                status: 'pepper_replied',
                createdAt: AT,
              },
            ],
            messages: [
              { threadId: thread, authorKind: 'member', body: 'How do I import?', createdAt: AT },
              { threadId: thread, authorKind: 'pepper', body: 'Clients → Import.', createdAt: AT },
            ],
          },
        }),
        AT,
      ).bytes,
    );
    expect(JSON.parse(files['support.json'] ?? '')).toEqual([
      {
        reference: 'PEP-7K3Q9D',
        kind: 'question',
        status: 'pepper_replied',
        openedAt: AT.toISOString(),
        messages: [
          { from: 'Your team', text: 'How do I import?', at: AT.toISOString() },
          { from: 'Pepper team', text: 'Clients → Import.', at: AT.toISOString() },
        ],
      },
    ]);
  });

  it('writes clients.csv in Pepper’s columns', () => {
    const files = unzip(buildBusinessExport(data(), AT).bytes);
    expect(files['clients.csv']).toBe(
      '\uFEFFpepper_client_id,name,email,phone,birthday,tags\r\n' +
        `${CLIENT},"Dee ""DJ"" Hart",dee@example.test,+15551234567,'--04-12,vip; beard\r\n`,
    );
  });

  it('gives visits in the business’s time zone, without a deleted client’s', () => {
    const files = unzip(buildBusinessExport(data(), AT).bytes);
    const lines = (files['visits.csv'] ?? '').split('\r\n');
    expect(lines[1]).toBe(
      `0190a000-0000-7000-8000-000000000100,2099-03-03,09:00,45,Skin fade,Jess,45.00,completed,${CLIENT},"Dee ""DJ"" Hart",dee@example.test,+15551234567`,
    );
    // The deleted client's visit isn't there to import (it would make a new client).
    expect(lines.slice(2)).toEqual(['']);
    const appointments = JSON.parse(files['appointments.json'] ?? '[]') as { clientId: unknown }[];
    expect(appointments.map((a) => a.clientId)).toEqual([CLIENT, null]);
  });

  it('puts the team’s services, hours and time off with each member', () => {
    const files = unzip(buildBusinessExport(data(), AT).bytes);
    expect(JSON.parse(files['team.json'] ?? '')).toEqual([
      {
        id: STAFF,
        displayName: 'Jess',
        color: '#336699',
        active: true,
        serviceIds: [SERVICE],
        hours: [{ weekday: 2, start: '09:00', end: '17:00' }],
        timeOff: [],
      },
    ]);
    // The zone in words, as the app says it (AC-W1-44), never its id.
    expect(files['README.txt']).toContain('in Central Time, the business');
    expect(files['README.txt']).not.toContain('America/Chicago');
  });

  it('names a time zone without a plain name by its city (AC-W1-44)', () => {
    const paris = { ...data(), business: { ...data().business, timeZone: 'Europe/Paris' } };
    const files = unzip(buildBusinessExport(paris, AT).bytes);
    expect(files['README.txt']).toContain('in Paris time, the business');
  });

  it('splits a CSV past the import’s row limit into files it takes whole', () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({
      ...data().clients[0],
      id: `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      name: `Client ${String(i)}`,
      email: null,
    })) as BusinessExportData['clients'];
    const files = unzip(buildBusinessExport(data({ clients: many }), AT).bytes);
    expect(parseImportFile(strToBytes(files['clients.csv'])).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(parseImportFile(strToBytes(files['clients-2.csv'])).rows).toHaveLength(1);
    expect(files['README.txt']).toContain('clients-2.csv');
    // 10,001 rows written, zipped and read back: ~8 s under coverage on this machine.
  }, 30_000);
});

function strToBytes(text: string | undefined): Uint8Array {
  return new TextEncoder().encode(text ?? '');
}

describe('Pepper’s own files read back (AC-W1-38)', () => {
  it('recognises clients.csv and visits.csv as Pepper’s, with every column mapped', () => {
    const files = unzip(buildBusinessExport(data(), AT).bytes);
    for (const name of ['clients.csv', 'visits.csv']) {
      const suggestion = suggestMapping(parseImportFile(strToBytes(files[name])));
      expect(suggestion.preset).toBe('pepper');
      expect(suggestion.columns.filter((column) => column.field === null)).toEqual([]);
    }
  });
});
