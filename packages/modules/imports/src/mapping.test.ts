import { describe, expect, it } from 'vitest';
import {
  detectPreset,
  mappingOf,
  mappingProblems,
  normalizeHeader,
  suggestMapping,
} from './mapping.js';
import type { Table } from './parse.js';

const table = (columns: string[], ...rows: string[][]): Table => ({
  format: 'csv',
  columns,
  rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});

describe('normalizeHeader', () => {
  it.each([
    ['E-mail Address', 'emailaddress'],
    [' First_Name ', 'firstname'],
    ['contact.phone', 'contactphone'],
  ])('%s → %s', (header, expected) => {
    expect(normalizeHeader(header)).toBe(expected);
  });
});

describe('detectPreset', () => {
  it('needs every header of a signature', () => {
    expect(detectPreset(['Cell Phone', 'Customer Since'])).toBe('vagaro');
    expect(detectPreset(['Cell Phone'])).toBeNull();
    expect(detectPreset(['Client Name', 'Total Spend'])).toBe('glossgenius');
  });
});

describe('suggestMapping (AC-W1-17)', () => {
  it('maps unknown headers by their values: emails, then phones', () => {
    const { columns } = suggestMapping(
      table(
        ['Who', 'Col A', 'Col B', 'Col C'],
        ['Ana', 'ana@example.com', '(555) 010-0001', '12'],
        ['Ben', 'ben@example.com', '555-010-0002', '7'],
        ['Cy', '', '+44 7911 123456', '3'],
      ),
    );
    expect(columns.map((c) => [c.column, c.field, c.by])).toEqual([
      ['Who', null, null],
      ['Col A', 'email', 'values'],
      ['Col B', 'phone', 'values'],
      ['Col C', null, null],
    ]);
  });

  it('doesn’t map a column of mixed values or of short numbers', () => {
    const { columns } = suggestMapping(
      table(['A', 'B'], ['ana@example.com', '5551234'], ['not an email', '5551235'], ['x', '']),
    );
    expect(columns.map((c) => c.field)).toEqual([null, null]);
  });

  it('leaves a column the preset ignores alone, even when its values look like phones', () => {
    const { preset, columns } = suggestMapping(
      table(
        ['Square Customer ID', 'First Name', 'Reference ID', 'Phone Number'],
        ['SQ1', 'Ana', '5550100001', '(555) 010-0002'],
        ['SQ2', 'Ben', '5550100003', ''],
      ),
    );
    expect(preset).toBe('square');
    expect(columns.map((c) => [c.column, c.field, c.by])).toEqual([
      ['Square Customer ID', 'external_id', 'preset'],
      ['First Name', 'first_name', 'preset'],
      ['Reference ID', null, null],
      ['Phone Number', 'phone', 'preset'],
    ]);
  });

  it('gives a single field to its first column only', () => {
    const { columns } = suggestMapping(
      table(['Name', 'Client', 'ID', 'Customer ID'], ['a', 'b', '1', '2']),
    );
    expect(columns.map((c) => c.field)).toEqual(['name', null, 'external_id', null]);
  });

  it('uses a full name over first and last name columns', () => {
    const { columns } = suggestMapping(
      table(['First Name', 'Last Name', 'Full Name'], ['a', 'b', 'a b']),
    );
    expect(columns.map((c) => c.field)).toEqual([null, null, 'name']);
    const pair = suggestMapping(table(['First Name', 'Last Name'], ['a', 'b'])).columns;
    expect(pair.map((c) => c.field)).toEqual(['first_name', 'last_name']);
  });

  it('names a mapping without a name as a problem', () => {
    const { columns } = suggestMapping(table(['Email'], ['ana@example.com']));
    expect(mappingProblems(mappingOf(columns))).toEqual([
      'Choose the column with the client’s name.',
    ]);
    expect(mappingProblems([{ column: 'Last', field: 'last_name' }])).toEqual([]);
  });
});
