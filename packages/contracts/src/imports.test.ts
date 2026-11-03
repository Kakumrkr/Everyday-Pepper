import { describe, expect, it } from 'vitest';
import {
  ImportMappingInputSchema,
  ImportMappingSchema,
  ImportUploadQuerySchema,
  MAX_IMPORT_COLUMNS,
} from './imports.js';

describe('ImportMappingSchema', () => {
  it('takes a mapping with email and phone from several columns', () => {
    const columns = [
      { column: 'First Name', field: 'first_name' },
      { column: 'Last Name', field: 'last_name' },
      { column: 'Cell Phone', field: 'phone' },
      { column: 'Home Phone', field: 'phone' },
      { column: 'Email', field: 'email' },
      { column: 'Birthday', field: null },
    ];
    expect(ImportMappingSchema.parse(columns)).toEqual(columns);
  });

  it.each([
    [
      'a column twice',
      [
        { column: 'A', field: 'name' },
        { column: 'A', field: null },
      ],
    ],
    [
      'two name columns',
      [
        { column: 'A', field: 'name' },
        { column: 'B', field: 'name' },
      ],
    ],
    [
      'two id columns',
      [
        { column: 'A', field: 'external_id' },
        { column: 'B', field: 'external_id' },
      ],
    ],
    ['an unknown field', [{ column: 'A', field: 'birthday' }]],
    ['no columns', []],
    ['an empty column name', [{ column: '', field: 'name' }]],
    [
      'too many columns',
      Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, i) => ({
        column: `c${String(i)}`,
        field: null,
      })),
    ],
  ])('refuses %s', (_label, columns) => {
    expect(ImportMappingSchema.safeParse(columns).success).toBe(false);
  });

  it('is strict about the body', () => {
    expect(
      ImportMappingInputSchema.safeParse({ columns: [{ column: 'A', field: 'name' }], x: 1 })
        .success,
    ).toBe(false);
  });
});

describe('ImportUploadQuerySchema', () => {
  it('takes no format or a known one', () => {
    expect(ImportUploadQuerySchema.parse({})).toEqual({});
    expect(ImportUploadQuerySchema.parse({ format: 'jsonl' })).toEqual({ format: 'jsonl' });
    expect(ImportUploadQuerySchema.safeParse({ format: 'xlsx' }).success).toBe(false);
  });
});
