import { MAX_IMPORT_BYTES, MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { ImportFileError, parseImportFile } from './parse.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const problem = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof ImportFileError) return [error.problem, error.message];
    throw error;
  }
  return null;
};

describe('parseImportFile', () => {
  it('reads CSV with a byte-order mark, quotes, line breaks in cells and blank lines', () => {
    const table = parseImportFile(
      bytes('﻿Name,Notes\r\n"Bell, Marcus","line one\nline two"\r\n\r\n,\r\nAna,\r\n'),
    );
    expect(table).toEqual({
      format: 'csv',
      columns: ['Name', 'Notes'],
      rows: [
        { row: 2, cells: ['Bell, Marcus', 'line one\nline two'] },
        { row: 5, cells: ['Ana', ''] },
      ],
    });
  });

  it('finds a semicolon or tab delimiter and pads short rows', () => {
    expect(parseImportFile(bytes('a;b\n1')).rows).toEqual([{ row: 2, cells: ['1', ''] }]);
    expect(parseImportFile(bytes('a\tb\n1\t2')).rows).toEqual([{ row: 2, cells: ['1', '2'] }]);
  });

  it('starts at the first line with something in it', () => {
    expect(parseImportFile(bytes('\n\nName\nAna')).rows).toEqual([{ row: 4, cells: ['Ana'] }]);
  });

  it('names blank headers by position and numbers repeated ones', () => {
    expect(parseImportFile(bytes('Phone,,Phone\n1,2,3')).columns).toEqual([
      'Phone',
      'Column 2',
      'Phone (2)',
    ]);
  });

  it('reads Windows-1252 when the file isn’t UTF-8', () => {
    const table = parseImportFile(
      Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x52, 0x65, 0x6e, 0xe9]),
    );
    expect(table.rows[0]?.cells).toEqual(['René']);
  });

  it('reads a JSON array, or the list inside an object, flattening nested records', () => {
    const list = parseImportFile(bytes('[{"a":1,"b":{"c":"x"}},{"d":[1,2],"e":true,"f":null}]'));
    expect(list).toEqual({
      format: 'json',
      columns: ['a', 'b.c', 'd', 'e', 'f'],
      rows: [
        { row: 1, cells: ['1', 'x', '', '', ''] },
        { row: 2, cells: ['', '', '1, 2', 'true', ''] },
      ],
    });
    const wrapped = parseImportFile(bytes('{"count":1,"data":[{"name":"Ana","tags":[{"x":1}]}]}'));
    expect(wrapped.rows).toEqual([{ row: 1, cells: ['Ana', '[{"x":1}]'] }]);
  });

  it('reads JSONL by line number, and takes the format from the query', () => {
    expect(parseImportFile(bytes('{"a":"x"}\n\n{"a":"y"}\n')).rows).toEqual([
      { row: 1, cells: ['x'] },
      { row: 3, cells: ['y'] },
    ]);
    expect(parseImportFile(bytes('{"a":"x"}'), 'jsonl').format).toBe('jsonl');
    expect(parseImportFile(bytes('[1]\n2'), 'csv').format).toBe('csv');
  });

  it.each([
    ['an empty file', '  \n', 'empty'],
    ['a header only', 'Name,Email\n', 'empty'],
    ['broken JSON', '[{"a":', 'unreadable'],
    ['a JSON list of numbers', '[1,2]', 'unreadable'],
    ['a bad JSONL line', '{"a":1}\nnope', 'unreadable'],
    ['a JSONL line that isn’t a record', '{"a":1}\n[1]', 'unreadable'],
  ])('refuses %s', (_label, text, expected) => {
    expect(problem(() => parseImportFile(bytes(text)))?.[0]).toBe(expected);
  });

  it('reads an object without a list as one record (a one-line JSONL file)', () => {
    expect(parseImportFile(bytes('{"name":"Ana","email":"ana@example.com"}\n'))).toEqual({
      format: 'json',
      columns: ['name', 'email'],
      rows: [{ row: 1, cells: ['Ana', 'ana@example.com'] }],
    });
  });

  it('says which line of a JSONL file is broken', () => {
    expect(problem(() => parseImportFile(bytes('{"a":1}\n\nnope')))?.[1]).toBe(
      'Line 3 of the file isn’t valid JSON.',
    );
  });

  it('refuses a file over the size, row or column limits', () => {
    expect(problem(() => parseImportFile(new Uint8Array(MAX_IMPORT_BYTES + 1)))?.[0]).toBe(
      'too_large',
    );
    const rows = (n: number) => `Name\n${'Ana\n'.repeat(n)}`;
    expect(parseImportFile(bytes(rows(MAX_IMPORT_ROWS))).rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(problem(() => parseImportFile(bytes(rows(MAX_IMPORT_ROWS + 1))))?.[0]).toBe(
      'too_many_rows',
    );
    const jsonl = '{"a":1}\n'.repeat(MAX_IMPORT_ROWS + 1);
    expect(problem(() => parseImportFile(bytes(jsonl)))?.[0]).toBe('too_many_rows');
    const wide = Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => `c${String(i)}`).join(
      ',',
    );
    expect(problem(() => parseImportFile(bytes(`${wide}\n1`)))?.[0]).toBe('too_many_columns');
    const record = Object.fromEntries(
      Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => [`k${String(i)}`, 1]),
    );
    expect(problem(() => parseImportFile(bytes(JSON.stringify([record]))))?.[0]).toBe(
      'too_many_columns',
    );
  });
});
