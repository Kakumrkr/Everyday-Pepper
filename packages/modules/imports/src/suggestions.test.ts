import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { suggestMapping } from './mapping.js';
import type { Table } from './parse.js';
import { acceptSuggestions, mappingQuestion, maskSample, openFields } from './suggestions.js';

const table = (columns: string[], ...rows: string[][]): Table => ({
  format: 'csv',
  columns,
  rows: rows.map((cells, i) => ({ row: i + 2, cells })),
});

describe('maskSample (AC-W1-46)', () => {
  it('keeps the shape of a value, never its letters or digits', () => {
    expect(maskSample('Ana López')).toBe('Aaa Aaaaa');
    expect(maskSample('(555) 010-2030')).toBe('(999) 999-9999');
    expect(maskSample('ana@example.com')).toBe('aaa@aaaaaaa.aaa');
    expect(maskSample(' 2024-03-05 ')).toBe('9999-99-99');
    expect(maskSample('$45.00')).toBe('$99.99');
    expect(maskSample('x'.repeat(80))).toHaveLength(40);
  });

  it('leaves no letter or digit of the value, for any text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 60 }), (value) => {
        expect(maskSample(value).replace(/[Aa9]/g, '')).not.toMatch(/[\p{L}\p{N}]/u);
      }),
    );
  });
});

describe('mappingQuestion (AC-W1-46)', () => {
  const file = table(
    ['Client', 'Contact', 'Loyalty pts', 'Fav'],
    ['Ana Lopez', 'ana@example.com', '120', 'Blue'],
    ['Ben Ode', 'ben@example.com', '', 'Red'],
    ['Cy Park', 'cy@example.com', '45', 'Blue'],
    ['Di Ray', 'di@example.com', '9', 'Green'],
  );

  it('asks only about unplaced columns, with masked, distinct samples', () => {
    const { columns } = suggestMapping(file);
    const question = mappingQuestion(file, columns, 'clients');
    expect(question?.columns).toEqual([
      { column: 'Loyalty pts', samples: ['999', '99', '9'] },
      { column: 'Fav', samples: ['Aaaa', 'Aaa', 'Aaaaa'] },
    ]);
    // The fields a column already fills alone aren't offered again.
    expect(question?.fields).not.toContain('name');
    expect(question?.fields).toContain('email');
    expect(JSON.stringify(question)).not.toMatch(/Ana|Lopez|example|120|Blue/);
  });

  it('asks nothing when every column is placed, decided or asked', () => {
    const { columns } = suggestMapping(file);
    const decided = columns.map((column) =>
      column.field === null ? { ...column, by: 'owner' as const } : column,
    );
    expect(mappingQuestion(file, decided, 'clients')).toBeNull();
    const asked = columns.map((column) => ({ ...column, suggestion: { field: null } }));
    expect(mappingQuestion(file, asked, 'clients')).toBeNull();
  });

  it('never asks about a column Pepper recognised but doesn’t import yet', () => {
    const notes = table(['Name', 'Notes'], ['Ana', 'Likes tea']);
    expect(mappingQuestion(notes, suggestMapping(notes).columns, 'clients')).toBeNull();
  });

  it('offers first and last name only without a full name, and the other way round', () => {
    const { columns } = suggestMapping(table(['First', 'X'], ['Ana', '1']));
    expect(openFields(columns)).toContain('last_name');
    expect(openFields(columns)).not.toContain('name');
  });
});

describe('acceptSuggestions (AC-W1-47)', () => {
  const file = table(
    ['Guest', 'Cell (best)', 'When', 'Treatment', 'Odd'],
    ['Ana Lopez', '555 010 20', '3/5/2026', 'Cut', 'x'],
  );
  const { columns } = suggestMapping(file);
  const question = mappingQuestion(file, columns, 'clients');
  if (question === null) throw new Error('the file has unplaced columns');

  it('stores a checked suggestion for each column asked, and maps nothing', () => {
    const next = acceptSuggestions(columns, question, {
      columns: [
        { column: 'Guest', field: 'name' },
        { column: 'Cell (best)', field: 'phone' },
        { column: 'When', field: 'visit_date' },
        { column: 'Treatment', field: 'service' },
        { column: 'Odd', field: null },
      ],
    });
    expect(next.map((c) => [c.column, c.field, c.suggestion?.field])).toEqual([
      ['Guest', null, 'name'],
      ['Cell (best)', null, 'phone'],
      ['When', null, 'visit_date'],
      ['Treatment', null, 'service'],
      ['Odd', null, null],
    ]);
  });

  it('drops a column not asked, a field taken twice, and visit fields without a date', () => {
    const next = acceptSuggestions(columns, question, {
      columns: [
        { column: 'Guest', field: 'name' },
        { column: 'Odd', field: 'name' },
        { column: 'Treatment', field: 'service' },
        { column: 'Nope', field: 'email' },
        { column: 'Guest', field: 'email' },
      ],
    });
    expect(next.map((c) => [c.column, c.suggestion?.field ?? null])).toEqual([
      ['Guest', 'name'],
      ['Cell (best)', null],
      ['When', null],
      ['Treatment', null],
      ['Odd', null],
    ]);
    expect(next.map(({ column }) => column)).not.toContain('Nope');
  });

  it('never changes a column the owner decided meanwhile, or one already placed', () => {
    const decided = columns.map((column) =>
      column.column === 'Guest'
        ? { ...column, field: 'name' as const, by: 'owner' as const }
        : column,
    );
    const next = acceptSuggestions(decided, question, {
      columns: [
        { column: 'Guest', field: 'email' },
        { column: 'Odd', field: 'name' },
      ],
    });
    expect(next.find((c) => c.column === 'Guest')).toMatchObject({
      field: 'name',
      suggestion: null,
    });
    // `name` is taken by the owner's choice, so it is no longer open.
    expect(next.find((c) => c.column === 'Odd')?.suggestion).toEqual({ field: null });
  });

  it('keeps a full name over first and last name suggestions', () => {
    const next = acceptSuggestions(columns, question, {
      columns: [
        { column: 'Guest', field: 'name' },
        { column: 'Odd', field: 'last_name' },
      ],
    });
    expect(next.find((c) => c.column === 'Odd')?.suggestion).toEqual({ field: null });
  });
});
