import { ImportBatchSchema, type ImportBatch, type ImportColumn } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  columnNote,
  commitImport,
  importFormatOf,
  importMessageFor,
  offersImport,
  precheckImport,
  previewSentence,
  remapImport,
  resultSentence,
  rowsToFixFirst,
  stepOf,
  undoable,
  undoUntilLabel,
  uploadImport,
  withField,
} from './imports';

const ID = '0190a0a0-0000-7000-8000-0000000000b1';
const counts = { rows: 158, create: 143, merge: 12, unchanged: 0, invalid: 3, skipped: 0 };

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  return ImportBatchSchema.parse({
    id: ID,
    status: 'staged',
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
  const client: ImportColumn = { column: 'Client', field: 'name', by: 'header', later: null };
  const nickname: ImportColumn = { column: 'Nickname', field: null, by: null, later: null };
  const mobile: ImportColumn = { column: 'Mobile', field: 'phone', by: 'values', later: null };
  const birthday: ImportColumn = { column: 'Birthday', field: null, by: null, later: 'birthday' };
  const columns = [client, nickname, mobile, birthday];

  it('moves a one-column field to the column chosen, and keeps the rest', () => {
    expect(withField(columns, 'Nickname', 'name')).toEqual([
      { column: 'Client', field: null },
      { column: 'Nickname', field: 'name' },
      { column: 'Mobile', field: 'phone' },
      { column: 'Birthday', field: null },
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
    expect(columnNote(birthday, null)).toBe('Birthdays come in a later update.');
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
