import { describe, expect, it } from 'vitest';
import { suggestMapping } from './mapping.js';
import { parseImportFile } from './parse.js';
import { fixture, MemoryBusiness } from './test-support.js';

// AC-W1-3: each tool's export imports cleanly, and importing it again creates no duplicates.

const files = [
  ['square.csv', 'square', 4],
  ['booksy.csv', 'booksy', 3],
  ['vagaro.csv', 'vagaro', 3],
  ['glossgenius.csv', 'glossgenius', 3],
  ['fresha.csv', 'fresha', 3],
  ['generic.csv', null, 3],
  ['own-app.json', null, 3],
  ['own-app.jsonl', null, 3],
] as const;

describe('the fixtures (AC-W1-3)', () => {
  it.each(files)('%s is recognised and every row becomes a client', (name, preset, count) => {
    const table = parseImportFile(fixture(name));
    expect(suggestMapping(table).preset).toBe(preset);
    const business = new MemoryBusiness();
    const plan = business.import(fixture(name));
    expect(plan.map((row) => [row.row, row.outcome, row.reasons])).toEqual(
      plan.map((row) => [row.row, 'create', []]),
    );
    expect(business.clients).toHaveLength(count);
    expect(business.clients.every((c) => c.email !== null || c.phone !== null)).toBe(true);
  });

  it.each(files)('importing %s again creates no duplicates', (name) => {
    const business = new MemoryBusiness();
    business.import(fixture(name));
    const again = business.import(fixture(name));
    expect(again.every((row) => row.outcome === 'unchanged')).toBe(true);
    expect(business.clients).toHaveLength(files.find(([n]) => n === name)?.[2] ?? 0);
  });

  it('every fixture together, twice, gives each person once', () => {
    const business = new MemoryBusiness();
    for (const [name] of files) business.import(fixture(name));
    for (const [name] of files) business.import(fixture(name));
    expect(business.clients).toHaveLength(files.reduce((sum, [, , n]) => sum + n, 0));
  });

  it('maps Square’s columns by its preset, with its id and the columns for later', () => {
    const { columns } = suggestMapping(parseImportFile(fixture('square.csv')));
    const of = (column: string) => columns.find((c) => c.column === column);
    expect(of('Square Customer ID')).toMatchObject({ field: 'external_id', by: 'preset' });
    expect(of('Email Address')).toMatchObject({ field: 'email', by: 'preset' });
    expect(of('Email Subscription Status')).toMatchObject({ field: null, later: null });
    expect(of('Birthday')).toMatchObject({ field: null, later: 'birthday' });
    expect(of('Memo')).toMatchObject({ field: null, later: 'notes' });
    expect(of('Reference ID')).toMatchObject({ field: null });
  });

  it('takes Vagaro’s first phone that has a number', () => {
    const business = new MemoryBusiness();
    business.import(fixture('vagaro.csv'));
    expect(business.clients.map((c) => c.phone)).toEqual([
      '+15550100301',
      '+15550100302',
      '+15550100303',
    ]);
  });

  it('reads an app’s nested JSON export by its header endings', () => {
    const { columns } = suggestMapping(parseImportFile(fixture('own-app.json')));
    expect(columns.map((c) => [c.column, c.field ?? c.later])).toEqual([
      ['id', 'external_id'],
      ['name', 'name'],
      ['contact.email', 'email'],
      ['contact.phone', 'phone'],
      ['tags', 'tags'],
      ['notes', 'notes'],
    ]);
  });
});

describe('the messy file (AC-W1-18)', () => {
  it('gives each problem row its reason, with the row number and the fix', () => {
    const plan = new MemoryBusiness().import(fixture('messy.csv'));
    expect(plan.map((row) => [row.row, row.outcome, row.reasons.map((r) => r.message)])).toEqual([
      [2, 'invalid', ['Row 2: “paula@” isn’t an email address. Fix it or leave it empty.']],
      [3, 'invalid', ['Row 3: there’s no name. Add the client’s name.']],
      [
        4,
        'invalid',
        ['Row 4: the phone “555-0903” has 7 digits; a US number needs 10, with the area code.'],
      ],
      [5, 'create', []],
      [6, 'create', []],
      [7, 'skipped', ['Row 7: the same client as row 6, so it’s skipped.']],
    ]);
  });
});
