import { describe, expect, it } from 'vitest';
import { sortOldestFirst } from './services/operator-support.js';

describe('sortOldestFirst (AC-X-20)', () => {
  it('puts the longest waiting first, ties by reference', () => {
    const at = (iso: string) => new Date(iso);
    const rows = [
      { reference: 'PEP-BBBBBB', waitingSince: at('2026-11-09T10:00:00Z') },
      { reference: 'PEP-CCCCCC', waitingSince: at('2026-11-09T08:00:00Z') },
      { reference: 'PEP-AAAAAA', waitingSince: at('2026-11-09T10:00:00Z') },
    ];
    expect(sortOldestFirst(rows).map((row) => row.reference)).toEqual([
      'PEP-CCCCCC',
      'PEP-AAAAAA',
      'PEP-BBBBBB',
    ]);
    expect(rows[0]?.reference).toBe('PEP-BBBBBB');
  });
});
