import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Table } from './parse.js';
import { mapRows, planRows, rowLabel, type KnownClient, type MatchIndex } from './rows.js';
import { MemoryBusiness } from './test-support.js';

const mapping = [
  { column: 'Name', field: 'name' },
  { column: 'Email', field: 'email' },
  { column: 'Phone', field: 'phone' },
  { column: 'Id', field: 'external_id' },
] as const;

const table = (...rows: string[][]): Table => ({
  format: 'csv',
  columns: ['Name', 'Email', 'Phone', 'Id'],
  rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});

const client = (
  id: string,
  name: string,
  email: string | null,
  phone: string | null,
): KnownClient => ({
  id,
  name,
  email,
  phone,
  tags: [],
  birthday: null,
});

function indexOf(clients: KnownClient[], refs: Record<string, KnownClient> = {}): MatchIndex {
  const byPhone = new Map<string, KnownClient[]>();
  for (const c of clients) if (c.phone) byPhone.set(c.phone, [...(byPhone.get(c.phone) ?? []), c]);
  return {
    byExternalId: new Map(Object.entries(refs)),
    byEmail: new Map(clients.flatMap((c) => (c.email ? [[c.email, c]] : []))),
    byPhone,
    byHash: new Map(),
  };
}

const plan = (t: Table, index: MatchIndex) => planRows('csv', mapRows(t, [...mapping]), index);

describe('mapRows', () => {
  it('cleans values: spaces collapsed, email lowercased, phone in international form', () => {
    const [row] = mapRows(table(['  Ana   Silva ', 'ANA@Example.com', '(555) 010-0001', ' 7 ']), [
      ...mapping,
    ]);
    expect(row).toMatchObject({
      name: 'Ana Silva',
      email: 'ana@example.com',
      phone: '+15550100001',
      externalId: '7',
      valid: true,
      reasons: [],
    });
  });

  it('builds a name from first and last name, or either alone', () => {
    const t: Table = {
      format: 'json',
      columns: ['f', 'l'],
      rows: [
        { row: 1, cells: ['Ana', 'Silva'] },
        { row: 2, cells: ['', 'Silva'] },
      ],
    };
    const rows = mapRows(t, [
      { column: 'f', field: 'first_name' },
      { column: 'l', field: 'last_name' },
      { column: 'missing', field: 'email' },
    ]);
    expect(rows.map((r) => r.name)).toEqual(['Ana Silva', 'Silva']);
  });

  it('gives each problem its reason', () => {
    const rows = mapRows(
      table(
        ['x'.repeat(121), '', '', ''],
        ['Ana', '', '+12', ''],
        ['Ana', '', '', 'i'.repeat(201)],
      ),
      [...mapping],
    );
    expect(rows.map((r) => [r.valid, r.reasons.map((x) => x.code)])).toEqual([
      [false, ['name_too_long']],
      [false, ['phone_invalid']],
      [false, ['value_too_long']],
    ]);
    expect(rows[1]?.reasons[0]?.message).toBe(
      'Row 3: “+12” isn’t a phone number. Use 10 digits, or + and the country code.',
    );
  });

  it('labels rows by format', () => {
    expect([rowLabel('csv', 2), rowLabel('json', 2), rowLabel('jsonl', 2)]).toEqual([
      'Row 2',
      'Item 2',
      'Line 2',
    ]);
  });
});

describe('planRows (D-3)', () => {
  const ana = client('a', 'Ana Silva', null, '+15550100001');

  it('matches by external id first, then email, filling only empty fields', () => {
    const byId = client('b', 'Bea', 'bea@example.com', null);
    const result = plan(
      table(
        ['Beatriz', 'other@example.com', '555-010-0009', 'X1'],
        ['Ana Silva', 'ana@example.com', '', ''],
      ),
      indexOf([byId, client('a', 'Ana Silva', 'ana@example.com', '+15550100001')], { X1: byId }),
    );
    expect(result.map((r) => [r.outcome, r.clientId, r.fills])).toEqual([
      ['merge', 'b', { phone: '+15550100009' }],
      ['unchanged', 'a', {}],
    ]);
  });

  it('matches by phone only when the name agrees, and never guesses between namesakes', () => {
    const twin = client('t', 'Ana Silva', null, '+15550100001');
    expect(
      plan(table(['ana silva', 'ana@example.com', '5550100001', '']), indexOf([ana]))[0],
    ).toMatchObject({
      outcome: 'merge',
      clientId: 'a',
      fills: { email: 'ana@example.com' },
    });
    // A family sharing a phone: a different name is a different client.
    expect(plan(table(['Leo Silva', '', '5550100001', '']), indexOf([ana]))[0]?.outcome).toBe(
      'create',
    );
    const shared = plan(table(['Ana Silva', '', '5550100001', '']), indexOf([ana, twin]))[0];
    expect(shared).toMatchObject({ outcome: 'skipped', reasons: [{ code: 'phone_shared' }] });
  });

  it('leaves out an email another client has', () => {
    const result = plan(
      table(['Ana Silva', 'bea@example.com', '5550100001', '']),
      indexOf([ana, client('b', 'Bea', 'bea@example.com', null)]),
    );
    // The email finds Bea first: the row is Bea's, and fills her empty phone.
    expect(result[0]).toMatchObject({
      outcome: 'merge',
      clientId: 'b',
      fills: { phone: '+15550100001' },
    });
    const byId = plan(
      table(['Ana Silva', 'bea@example.com', '', 'A1']),
      indexOf([ana, client('b', 'Bea', 'bea@example.com', null)], { A1: ana }),
    );
    expect(byId[0]).toMatchObject({
      outcome: 'unchanged',
      clientId: 'a',
      reasons: [{ code: 'email_taken' }],
    });
  });

  it('skips a second row for a client an earlier row created or matched', () => {
    const result = plan(
      table(
        ['Ana Silva', '', '5550100001', ''],
        ['Ana Silva', 'ana@example.com', '5550100001', ''],
        ['Cy', 'cy@example.com', '', ''],
        ['Cy Again', 'cy@example.com', '', ''],
      ),
      indexOf([ana]),
    );
    expect(result.map((r) => [r.outcome, r.reasons.map((x) => x.message)])).toEqual([
      ['unchanged', []],
      ['skipped', ['Row 3: the same client as row 2, so it’s skipped.']],
      ['create', []],
      ['skipped', ['Row 5: the same client as row 4, so it’s skipped.']],
    ]);
  });

  it('treats a client an earlier chunk of the run claimed as a duplicate', () => {
    const ana = client('a', 'Ana Silva', 'ana@example.com', null);
    const result = planRows(
      'csv',
      mapRows(table(['Ana Silva', 'ana@example.com', '5550100001', '']), [...mapping]),
      indexOf([ana]),
      { claimed: new Map([['a', 7]]) },
    );
    expect(result[0]).toMatchObject({
      outcome: 'skipped',
      reasons: [
        { code: 'duplicate_in_file', message: 'Row 2: the same client as row 7, so it’s skipped.' },
      ],
    });
  });

  it('finds name-only rows again by an earlier import’s identical row', () => {
    const business = new MemoryBusiness();
    const file = Buffer.from('Name\nAna\nBen\n');
    expect(business.import(file).map((r) => r.outcome)).toEqual(['create', 'create']);
    expect(business.import(file).map((r) => r.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(business.clients).toHaveLength(2);
  });

  const name = fc.constantFrom('Ana', 'Ben', 'Cy', 'Dee');
  const email = fc.option(fc.constantFrom('a@example.com', 'b@example.com', 'c@example.com'), {
    nil: '',
  });
  const phone = fc.option(fc.constantFrom('5550100001', '5550100002', '+447911123456'), {
    nil: '',
  });
  const id = fc.option(fc.constantFrom('1', '2', '3'), { nil: '' });
  const rows = fc.array(fc.tuple(name, email, phone, id), { maxLength: 25 });
  const csv = (records: string[][]) =>
    Buffer.from(['Name,Email,Phone,Id', ...records.map((r) => r.join(','))].join('\n'));

  it('finds a repeat row again on a re-import, when its phone has become ambiguous', () => {
    // fast-check's counterexample from S49's CI (seed 1909035259): the third row of the second
    // file was skipped as Cy's repeat and, recording no client, became a new client when the
    // second file came again and Cy's phone was shared by then.
    const first = [
      ['Cy', 'a@example.com', '5550100002', ''],
      ['Ana', 'a@example.com', '5550100002', '1'],
    ];
    const second = [
      ['Cy', '', '', '1'],
      ['Cy', 'b@example.com', '5550100002', ''],
      ['Ana', 'b@example.com', '', ''],
    ];
    const business = new MemoryBusiness();
    business.import(csv(first));
    business.import(csv(second));
    const count = business.clients.length;
    business.import(csv(first));
    business.import(csv(second));
    expect(business.clients).toHaveLength(count);
  });

  it('never creates two clients with one email, and a re-import creates nothing (property)', () => {
    fc.assert(
      fc.property(rows, rows, (first, second) => {
        const business = new MemoryBusiness();
        if (first.length > 0) business.import(csv(first));
        if (second.length > 0) business.import(csv(second));
        const emails = business.clients.flatMap((c) => (c.email ? [c.email] : []));
        expect(new Set(emails).size).toBe(emails.length);
        const count = business.clients.length;
        if (first.length > 0) business.import(csv(first));
        if (second.length > 0) business.import(csv(second));
        expect(business.clients).toHaveLength(count);
      }),
      { numRuns: 300 },
    );
  });
});

describe('tags and birthdays (S49, AC-W1-25)', () => {
  const withDetails = [
    { column: 'Name', field: 'name' },
    { column: 'Email', field: 'email' },
    { column: 'Birthday', field: 'birthday' },
    { column: 'Tags', field: 'tags' },
  ] as const;
  const detailsTable = (...rows: string[][]): Table => ({
    format: 'csv',
    columns: ['Name', 'Email', 'Birthday', 'Tags'],
    rows: rows.map((cells, i) => ({ row: i + 2, cells })),
  });

  it('reads them, and a birthday that can’t be read is a warning, never a stop', () => {
    const rows = mapRows(
      detailsTable(['Ana', 'ana@example.com', 'April 12', 'VIP; Color'], ['Ben', '', 'soon', '']),
      [...withDetails],
    );
    expect(rows[0]).toMatchObject({
      birthday: { month: 4, day: 12, year: null },
      tags: ['VIP', 'Color'],
      valid: true,
    });
    expect(rows[1]).toMatchObject({ birthday: null, valid: true, reasons: [] });
    expect(rows[1]?.warnings.map((w) => w.message)).toEqual([
      'Row 3: the birthday “soon” can’t be read, so it’s left out. Write it as 4/12/1990 or April 12.',
    ]);
    // The warning stays on the planned row.
    const [, ben] = planRows('csv', rows, indexOf([]));
    expect(ben?.outcome).toBe('create');
    expect(ben?.reasons.map((r) => r.code)).toEqual(['birthday_invalid']);
  });

  it('fills a birthday only when empty, and adds only the tags the client lacks', () => {
    const ana = { ...client('c1', 'Ana', 'ana@example.com', null), tags: ['vip'] };
    const ben = {
      ...client('c2', 'Ben', 'ben@example.com', null),
      birthday: { month: 1, day: 2, year: null },
    };
    const planned = planRows(
      'csv',
      mapRows(
        detailsTable(
          ['Ana', 'ana@example.com', '4/12/1990', 'VIP, Color'],
          ['Ben', 'ben@example.com', '5/5', 'New'],
        ),
        [...withDetails],
      ),
      indexOf([ana, ben]),
    );
    expect(planned.map((p) => [p.outcome, p.fills])).toEqual([
      ['merge', { birthday: { month: 4, day: 12, year: 1990 }, tags: ['Color'] }],
      ['merge', { tags: ['New'] }],
    ]);
  });
});

describe('several rows of one client (S49, visits files)', () => {
  it('says which row or client a repeat belongs to', () => {
    const known = client('c1', 'Ana', 'ana@example.com', null);
    const planned = plan(
      table(
        ['Ben', 'ben@example.com', '', ''],
        ['Ben', 'ben@example.com', '', ''],
        ['Ana', 'ana@example.com', '', ''],
        ['Ana', 'ana@example.com', '', ''],
      ),
      indexOf([known]),
    );
    expect(planned.map((p) => [p.outcome, p.sameAs])).toEqual([
      ['create', undefined],
      ['skipped', { position: 0 }],
      ['unchanged', undefined],
      ['skipped', { clientId: 'c1' }],
    ]);
  });
});

describe('a visits file’s rows (S49)', () => {
  const visitMapping = [
    { column: 'Name', field: 'name' },
    { column: 'Date', field: 'visit_date' },
    { column: 'Time', field: 'visit_time' },
    { column: 'Length', field: 'duration' },
    { column: 'Price', field: 'price' },
  ] as const;
  const visitTable = (...rows: string[][]): Table => ({
    format: 'csv',
    columns: ['Name', 'Date', 'Time', 'Length', 'Price'],
    rows: rows.map((cells, i) => ({ row: i + 2, cells })),
  });

  it('gives each unreadable part of a visit its reason', () => {
    const rows = mapRows(
      visitTable(
        ['Ana', '1/5/2026', '2:30 PM', '45', '$45'],
        ['Ben', 'someday', '2:30 PM', '45', ''],
        ['Cy', '1/5/2026', 'late', '45', ''],
        ['Di', '1/5/2026', '', '45', ''],
        ['Ed', '1/5/2026', '9 AM', '2 days', ''],
        ['Flo', '1/5/2026', '9 AM', '30', 'free'],
      ),
      [...visitMapping],
    );
    expect(
      rows.map((r) => [r.valid, r.reasons.map((x) => x.code), r.warnings.map((x) => x.code)]),
    ).toEqual([
      [true, [], []],
      [false, ['date_invalid'], []],
      [false, ['time_invalid'], []],
      [false, ['time_invalid'], []],
      [false, ['duration_invalid'], []],
      [true, [], ['price_invalid']],
    ]);
    expect(rows[0]?.visit).toMatchObject({
      time: 870,
      duration: 45,
      priceCents: 4500,
      status: 'kept',
    });
  });
});
