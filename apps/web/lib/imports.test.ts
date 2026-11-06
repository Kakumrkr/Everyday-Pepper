import {
  ImportBatchSchema,
  ImportRowSchema,
  type ImportBatch,
  type ImportColumn,
} from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  batchInAddress,
  clientsHref,
  columnNote,
  leftOutLine,
  needsSuggestions,
  suggestionOf,
  suggestionWords,
  commitImport,
  importSteps,
  importFormatOf,
  importMessageFor,
  moreRowsNote,
  offersImport,
  precheckImport,
  previewSentence,
  remapImport,
  resultSentence,
  rowBadge,
  rowsToFixFirst,
  stepOf,
  takenTimes,
  bookAgainHref,
  undoable,
  undoQuestion,
  undoUntilLabel,
  uploadImport,
  visitLine,
  withField,
} from './imports';

const ID = '0190a0a0-0000-7000-8000-0000000000b1';
const counts = {
  rows: 158,
  create: 143,
  merge: 12,
  unchanged: 0,
  invalid: 3,
  skipped: 0,
  conflict: 0,
  clients: 143,
  past: 0,
  upcoming: 0,
};

function batch(overrides: Record<string, unknown> = {}): ImportBatch {
  return ImportBatchSchema.parse({
    id: ID,
    status: 'staged',
    kind: 'clients',
    notices: [],
    format: 'csv',
    preset: null,
    columns: [],
    problems: [],
    counts,
    createdAt: '2026-11-03T15:00:00.000Z',
    committedAt: null,
    finishedAt: null,
    undoUntil: null,
    undoneAt: null,
    undo: null,
    ...overrides,
  });
}

const preview = (b: ImportBatch) => ({ batch: b, rows: [] });
const answering = (status: number, body: unknown) =>
  vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

describe('previewSentence (AC-W1-21)', () => {
  it('says the counts as one sentence', () => {
    expect(previewSentence(counts)).toBe('143 new clients, 12 to fill in, 3 to fix');
  });

  it('adds the duplicates and the clients already here only when there are any', () => {
    expect(previewSentence({ ...counts, create: 1, skipped: 2, unchanged: 20 })).toBe(
      '1 new client, 12 to fill in, 3 to fix, 2 left out, 20 already here',
    );
  });

  it('says only the counts there are, or its first one when there are none (S56b)', () => {
    expect(previewSentence({ ...counts, create: 2, merge: 0, invalid: 0 })).toBe('2 new clients');
    expect(previewSentence({ ...counts, create: 0, merge: 5, invalid: 0, unchanged: 20 })).toBe(
      '5 to fill in, 20 already here',
    );
    expect(previewSentence({ ...counts, create: 0, merge: 0, invalid: 0 })).toBe('0 new clients');
    expect(previewSentence({ ...counts, create: 3, merge: 0, invalid: 1, skipped: 1 })).toBe(
      '3 new clients, 1 to fix, 1 left out',
    );
  });
});

describe('rowsToFixFirst (AC-W1-21)', () => {
  it('puts the rows to fix first, then those left out, then the rest', () => {
    const row = (n: number, outcome: 'create' | 'invalid' | 'skipped') => ({
      row: n,
      name: null,
      email: null,
      phone: null,
      outcome,
      reasons: [],
      clientId: null,
      tags: [],
      birthday: null,
      visit: null,
    });
    const { toFix, leftOut, rest } = rowsToFixFirst([
      row(2, 'create'),
      row(3, 'skipped'),
      row(4, 'invalid'),
    ]);
    expect(toFix.map((r) => r.row)).toEqual([4]);
    expect(leftOut.map((r) => r.row)).toEqual([3]);
    expect(rest.map((r) => r.row)).toEqual([2]);
  });
});

describe('the file', () => {
  it('reads the format from the name, and leaves the rest to the api', () => {
    expect(importFormatOf('clients.CSV')).toBe('csv');
    expect(importFormatOf('export.json')).toBe('json');
    expect(importFormatOf('export.ndjson')).toBe('jsonl');
    expect(importFormatOf('clients')).toBeUndefined();
  });

  it('stops an empty or too large file before sending it', () => {
    expect(precheckImport({ size: 0 })).toContain('empty');
    expect(precheckImport({ size: 6 * 1024 * 1024 })).toContain('5 MB');
    expect(precheckImport({ size: 100 })).toBeNull();
  });

  it('sends a CSV as text, a JSON file as bytes, with its format', async () => {
    const fetch = answering(201, preview(batch()));
    const csv = await uploadImport(new File(['Name\nAna'], 'clients.csv'), fetch);
    expect(csv.ok).toBe(true);
    await uploadImport(new File(['[]'], 'clients.json'), fetch);
    await uploadImport(new File(['x'], 'clients'), fetch);
    const sent = fetch.mock.calls.map(([path, init]) => [
      path,
      new Headers(init?.headers).get('content-type'),
    ]);
    expect(sent).toEqual([
      ['/v1/imports?format=csv', 'text/csv'],
      ['/v1/imports?format=json', 'application/octet-stream'],
      ['/v1/imports', 'application/octet-stream'],
    ]);
  });

  it('shows the api’s own sentence for a file it can’t read', async () => {
    const fetch = answering(422, { code: 'import_rejected', message: 'The file has no rows.' });
    const answer = await uploadImport(new File(['Name\n'], 'clients.csv'), fetch);
    expect(answer).toMatchObject({ ok: false, status: 422, message: 'The file has no rows.' });
  });

  it('says what to do with a file over 5 MB, and when offline', async () => {
    expect(importMessageFor(413, { code: 'import_too_large', message: 'Too large.' })).toContain(
      'split the file',
    );
    const offline = vi.fn<typeof fetch>(() => Promise.reject(new Error('offline')));
    expect(await commitImport(ID as ImportBatch['id'], offline)).toMatchObject({ status: 0 });
  });

  it('keeps the app’s words for other refusals', () => {
    expect(importMessageFor(403, { code: 'forbidden' })).toContain('role');
  });
});

describe('the mapping (AC-W1-17)', () => {
  const client: ImportColumn = {
    column: 'Client',
    field: 'name',
    by: 'header',
    later: null,
    suggestion: null,
  };
  const nickname: ImportColumn = {
    column: 'Nickname',
    field: null,
    by: null,
    later: null,
    suggestion: null,
  };
  const mobile: ImportColumn = {
    column: 'Mobile',
    field: 'phone',
    by: 'values',
    later: null,
    suggestion: null,
  };
  const notes: ImportColumn = {
    column: 'Notes',
    field: null,
    by: null,
    later: 'notes',
    suggestion: null,
  };
  const columns = [client, nickname, mobile, notes];

  it('moves a one-column field to the column chosen, and keeps the rest', () => {
    expect(withField(columns, 'Nickname', 'name')).toEqual([
      { column: 'Client', field: null },
      { column: 'Nickname', field: 'name' },
      { column: 'Mobile', field: 'phone' },
      { column: 'Notes', field: null },
    ]);
    expect(withField(columns, 'Mobile', '')[2]).toEqual({ column: 'Mobile', field: null });
    // Several columns may give a phone: the first valid one wins.
    expect(withField(columns, 'Nickname', 'phone')[2]).toEqual({
      column: 'Mobile',
      field: 'phone',
    });
    expect(withField(columns, 'Mobile', 'not-a-field')[2]).toEqual({
      column: 'Mobile',
      field: null,
    });
  });

  it('says why a column fills what it does, and names the later ones', () => {
    expect(columnNote({ ...client, by: 'preset' }, 'square')).toBe('As Square exports it.');
    expect(columnNote(client, null)).toBe('From the column’s name.');
    expect(columnNote(mobile, null)).toBe('From what’s in it.');
    expect(columnNote(notes, null)).toBe('Notes come in a later update.');
    expect(columnNote(nickname, null)).toBe('Not imported.');
  });

  it('sends the whole mapping', async () => {
    const fetch = answering(200, preview(batch()));
    await remapImport(ID as ImportBatch['id'], withField(columns, 'Mobile', ''), fetch);
    const [path, init] = fetch.mock.calls[0] ?? [];
    expect(path).toBe(`/v1/imports/${ID}/mapping`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toMatchObject({
      columns: [{ column: 'Client' }, {}, { field: null }, {}],
    });
  });
});

describe('the result and undo (AC-W1-19)', () => {
  const now = new Date('2026-11-04T12:00:00.000Z');

  it('opens a staged import at its preview and a started one at its result', () => {
    expect(stepOf(null)).toBe('upload');
    expect(stepOf(batch())).toBe('preview');
    expect(stepOf(batch({ status: 'running' }))).toBe('result');
  });

  it('says what it did, or what the undo did', () => {
    expect(resultSentence(batch({ status: 'done' }))).toBe('143 new clients added, 12 filled in.');
    expect(resultSentence(batch({ status: 'queued' }))).toContain('Importing 158 rows');
    expect(
      resultSentence(batch({ status: 'undone', undo: { deleted: 141, restored: 12, kept: 2 } })),
    ).toBe(
      'Undone: 141 clients removed, 12 cleared again. 2 clients were kept: they booked or changed since.',
    );
    expect(
      resultSentence(batch({ status: 'undone', undo: { deleted: 1, restored: 0, kept: 0 } })),
    ).toBe('Undone: 1 client removed, 0 cleared again.');
  });

  it('can be undone until its day, in the business’s time zone', () => {
    const done = batch({ status: 'done', undoUntil: '2026-11-10T15:00:00.000Z' });
    expect(undoable(done, now)).toBe(true);
    expect(undoable(done, new Date('2026-11-10T15:00:00.000Z'))).toBe(false);
    expect(undoable(batch({ status: 'undone', undoUntil: done.undoUntil }), now)).toBe(false);
    expect(undoUntilLabel(done, 'America/New_York')).toBe('Tuesday, November 10');
    expect(undoUntilLabel(batch(), 'America/New_York')).toBeNull();
  });
});

describe('offersImport (AC-W1-20)', () => {
  it('offers the import until one has finished and not been undone', () => {
    expect(offersImport([])).toBe(true);
    expect(offersImport([batch(), batch({ status: 'undone' }), batch({ status: 'failed' })])).toBe(
      true,
    );
    expect(offersImport([batch({ status: 'done' })])).toBe(false);
  });
});

describe('a long preview and the undo question', () => {
  const row = (n: number, outcome: 'create' | 'invalid') => ({
    row: n,
    name: 'Ana',
    email: null,
    phone: null,
    outcome,
    reasons: [],
    clientId: null,
    tags: [],
    birthday: null,
    visit: null,
  });

  it('says when rows to fix are beyond the rows shown, and nothing when all are shown', () => {
    const many = {
      ...counts,
      rows: 300,
      create: 50,
      merge: 0,
      unchanged: 0,
      invalid: 250,
      skipped: 0,
    };
    const shown = Array.from({ length: 200 }, (_, i) => row(i + 2, 'invalid'));
    expect(moreRowsNote(many, shown)).toBe(
      'Showing 200 of 300 rows. 50 more rows to fix aren’t shown: fix the ones above, then pick the file again.',
    );
    const fine = { ...many, create: 299, invalid: 1 };
    expect(
      moreRowsNote(fine, [
        row(2, 'invalid'),
        ...shown.slice(1).map((r) => ({ ...r, outcome: 'create' as const })),
      ]),
    ).toBe('Showing 200 of 300 rows. The rest are ready to import.');
    expect(moreRowsNote({ ...many, rows: 1 }, [row(2, 'create')])).toBeNull();
    // A visits file: times taken beyond the cut aren't "ready to import".
    expect(
      moreRowsNote({ ...fine, invalid: 0, create: 270, conflict: 30 }, [
        ...shown.slice(0, 10).map((r) => ({ ...r, outcome: 'conflict' as const })),
        ...shown.slice(10).map((r) => ({ ...r, outcome: 'create' as const })),
      ]),
    ).toBe(
      'Showing 200 of 300 rows. 20 more times taken aren’t shown; the rest are ready to import.',
    );
  });

  it('names what an undo takes back, in the right number', () => {
    expect(undoQuestion({ ...counts, create: 1, merge: 0 })).toBe(
      'I’ll remove the 1 client it added. Anyone who booked since stays.',
    );
    expect(undoQuestion(counts)).toContain('143 clients it added and clear the emails and phones');
  });
});

describe('a visits file (AC-W1-27)', () => {
  const visitCounts = {
    rows: 52,
    create: 46,
    merge: 0,
    unchanged: 1,
    invalid: 3,
    skipped: 0,
    conflict: 2,
    clients: 12,
    past: 40,
    upcoming: 6,
  };
  const visits = (overrides: Record<string, unknown> = {}) =>
    batch({ kind: 'visits', counts: visitCounts, ...overrides });
  const visitRow = (
    n: number,
    outcome: 'create' | 'invalid' | 'skipped' | 'conflict' | 'unchanged',
    status: 'completed' | 'no_show' | 'confirmed' = 'completed',
  ) =>
    ImportRowSchema.parse({
      row: n,
      name: 'Ana Ruiz',
      email: null,
      phone: null,
      outcome,
      reasons: [],
      clientId: '0190a0a0-0000-7000-8000-0000000000c1',
      tags: [],
      birthday: null,
      visit: {
        startsAt: '2026-11-10T19:30:00.000Z',
        durationMinutes: 45,
        service: 'Skin fade',
        staff: 'Dre',
        status,
        bookingId: null,
      },
    });

  it('names its steps after visits', () => {
    expect(importSteps('visits')[2]).toBe('Check the visits');
    expect(importSteps('clients')[2]).toBe('Check the clients');
  });

  it('says the preview as one sentence of visits, clients and rows to fix', () => {
    expect(previewSentence(visitCounts, 'visits')).toBe(
      '40 past visits, 6 upcoming, 12 new clients, 3 to fix, 2 times taken, 1 already here',
    );
    expect(
      previewSentence(
        { ...visitCounts, past: 1, upcoming: 0, clients: 1, conflict: 0, unchanged: 0 },
        'visits',
      ),
    ).toBe('1 past visit, 1 new client, 3 to fix');
  });

  it('says the visits counts there are, or its first one when there are none', () => {
    const none = { ...visitCounts, past: 0, upcoming: 0, clients: 0, invalid: 0, conflict: 0 };
    expect(previewSentence({ ...none, unchanged: 0 }, 'visits')).toBe('0 past visits');
    expect(previewSentence({ ...none, upcoming: 2, unchanged: 0 }, 'visits')).toBe('2 upcoming');
  });

  it('lists the times taken apart from the rows to fix', () => {
    const { toFix, taken, leftOut, rest } = rowsToFixFirst([
      visitRow(2, 'create'),
      visitRow(3, 'conflict', 'confirmed'),
      visitRow(4, 'invalid'),
      visitRow(5, 'skipped'),
    ]);
    expect(toFix.map((r) => r.row)).toEqual([4]);
    expect(taken.map((r) => r.row)).toEqual([3]);
    expect(leftOut.map((r) => r.row)).toEqual([5]);
    expect(rest.map((r) => r.row)).toEqual([2]);
  });

  it('shows a visit’s date with its year in the business’s time zone, its service and staff', () => {
    const { visit } = visitRow(2, 'create');
    if (visit === null) throw new Error('a visit row has its visit');
    expect(visitLine(visit, 'America/New_York')).toBe(
      'Tue, Nov 10, 2026, 2:30 PM · Skin fade with Dre',
    );
    expect(visitLine(visit, 'America/Los_Angeles')).toBe(
      'Tue, Nov 10, 2026, 11:30 AM · Skin fade with Dre',
    );
  });

  it('badges a visit by what it becomes', () => {
    expect(rowBadge(visitRow(2, 'create')).label).toBe('Past visit');
    expect(rowBadge(visitRow(2, 'create', 'no_show')).label).toBe('No-show');
    expect(rowBadge(visitRow(2, 'create', 'confirmed')).label).toBe('Upcoming');
    expect(rowBadge(visitRow(2, 'conflict', 'confirmed')).label).toBe('Time taken');
    expect(rowBadge(visitRow(2, 'unchanged')).label).toBe('Already here');
    expect(rowBadge({ ...visitRow(2, 'create'), visit: null }).label).toBe('New');
  });

  it('says what it added and that no one was emailed', () => {
    expect(resultSentence(visits({ status: 'done' }))).toBe(
      'Added 40 past visits, 6 upcoming appointments and 12 new clients. No one was emailed.',
    );
    expect(
      resultSentence(
        visits({
          status: 'done',
          counts: { ...visitCounts, upcoming: 0, conflict: 0, clients: 0, past: 1 },
        }),
      ),
    ).toBe('Added 1 past visit.');
    expect(resultSentence(visits({ status: 'failed' }))).toBe(
      'Added 40 past visits, 6 upcoming appointments and 12 new clients before it stopped. Undo it, or try the file again later.',
    );
    expect(
      resultSentence(
        visits({
          status: 'undone',
          undo: { deleted: 12, restored: 0, kept: 0, bookings: 45, bookingsKept: 1 },
        }),
      ),
    ).toBe('Undone: 45 visits and 12 clients removed. 1 visit was kept: it changed since.');
  });

  it('names the visits and clients an undo takes back', () => {
    expect(undoQuestion(visitCounts, 'visits')).toBe(
      'I’ll remove the 46 visits and 12 new clients it added, and clear any email or phone it filled in. A visit changed since, and anyone who booked since, stays.',
    );
  });
});

describe('after the import (AC-W1-29)', () => {
  it('opens the Clients list filtered to the import’s new clients, when it added any', () => {
    expect(clientsHref(batch({ status: 'done' }))).toBe(`/clients?import=${ID}`);
    expect(clientsHref(batch({ status: 'failed' }))).toBe(`/clients?import=${ID}`);
    expect(clientsHref(batch({ status: 'done', counts: { ...counts, clients: 0 } }))).toBe(
      '/clients',
    );
    expect(clientsHref(batch({ status: 'undone' }))).toBe('/clients');
  });

  it('lists the times taken once the import ran, and how many more the file has', () => {
    const taken = (n: number, clientId: string | null) =>
      ImportRowSchema.parse({
        row: n,
        name: 'Ana Ruiz',
        email: null,
        phone: null,
        outcome: 'conflict' as const,
        reasons: [],
        clientId,
        tags: [],
        birthday: null,
        visit: {
          startsAt: '2026-11-10T19:30:00.000Z',
          durationMinutes: 45,
          service: 'Skin fade',
          staff: 'Dre',
          status: 'confirmed' as const,
          bookingId: null,
        },
      });
    const done = batch({
      status: 'done',
      kind: 'visits',
      counts: { ...counts, conflict: 3 },
    });
    const list = takenTimes(done, [
      taken(4, '0190a0a0-0000-7000-8000-0000000000c1'),
      ImportRowSchema.parse({ ...taken(5, null), outcome: 'create' }),
      taken(6, null),
    ]);
    // A time taken without its client (never after a run) is listed without "Book again".
    expect(list.rows.map((r) => r.row)).toEqual([4, 6]);
    expect(list.more).toBe(1);
    expect(takenTimes(batch({ status: 'staged', kind: 'visits' }), [taken(4, null)]).rows).toEqual(
      [],
    );
  });
});

describe('bookAgainHref (AC-W1-33)', () => {
  const CLIENT = '0190a0a0-0000-7000-8000-0000000000c1';
  const visit = {
    startsAt: '2099-11-10T19:30:00.000Z',
    durationMinutes: 45,
    service: 'Skin  Fade',
    staff: 'dre',
    status: 'confirmed' as const,
    bookingId: null,
  };
  const choices = {
    services: [
      { id: 's-cut', name: 'Cut' },
      { id: 's-fade', name: 'skin fade' },
    ],
    staff: [
      { id: 'm-dre', displayName: 'Dre Lewis' },
      { id: 'm-sam', displayName: 'Sam' },
    ],
  };

  it('opens Book with the service and staff matched by name, ids in the address', () => {
    expect(bookAgainHref(CLIENT, visit, choices)).toBe(
      `/clients/${CLIENT}?book=1&service=s-fade&staff=m-dre`,
    );
  });

  it('leaves out what doesn’t match, or matches more than one first name', () => {
    expect(
      bookAgainHref(
        CLIENT,
        { ...visit, service: 'Beard', staff: 'Dre' },
        {
          ...choices,
          staff: [...choices.staff, { id: 'm-dre2', displayName: 'Dre Kim' }],
        },
      ),
    ).toBe(`/clients/${CLIENT}?book=1`);
    expect(bookAgainHref(CLIENT, null, choices)).toBe(`/clients/${CLIENT}?book=1`);
  });
});

describe('batchInAddress', () => {
  it('reads the import a link or Back names, and nothing else', () => {
    expect(batchInAddress(`?batch=${ID}`)).toBe(ID);
    expect(batchInAddress('?batch=not-an-id')).toBeNull();
    expect(batchInAddress('')).toBeNull();
  });
});

describe('suggestions and what is left out (S56a.2, AC-W1-46, AC-W1-48)', () => {
  const column = (part: Partial<ImportColumn> & { column: string }): ImportColumn => ({
    field: null,
    by: null,
    later: null,
    suggestion: null,
    ...part,
  });
  const name = column({ column: 'Client', field: 'name', by: 'header' });
  const cell = column({ column: 'Cell', suggestion: { field: 'phone' } });
  const fav = column({ column: 'Fav', suggestion: { field: null } });
  const tel = column({ column: 'Tel', by: 'owner' });
  const notes = column({ column: 'Notes', later: 'notes' });
  const odd = column({ column: 'Odd' });

  it('asks only while an unplaced column was never asked about', () => {
    expect(needsSuggestions([name, odd])).toBe(true);
    expect(needsSuggestions([name, cell, fav, tel, notes])).toBe(false);
  });

  it('shows a suggestion only while the column isn’t used', () => {
    expect(suggestionOf(cell)).toBe('phone');
    expect(suggestionWords('phone')).toBe('Looks like Phone to me.');
    expect(suggestionOf({ ...cell, field: 'phone', by: 'owner' })).toBeNull();
    expect(suggestionOf(fav)).toBeNull();
  });

  it('names each column left out and why, in one line', () => {
    expect(leftOutLine([name, cell, fav, tel, notes, odd])).toBe(
      'Not imported: Cell (I think it’s Phone: change it in Columns), Fav (nothing in Pepper fits it), ' +
        'Tel (you left it out), Notes (notes come later), Odd (nothing in Pepper fits it).',
    );
    expect(leftOutLine([name])).toBeNull();
  });
});
