import { describe, expect, it } from 'vitest';
import { seenAgain, sortOldestFirst } from './services/operator-support.js';

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

describe('seenAgain (AC-X-22)', () => {
  const now = new Date('2026-11-09T15:00:00Z');
  const at = (iso: string) => new Date(iso);
  it('is news when never seen, after a new message, or an hour later', () => {
    const lastMessageAt = at('2026-11-09T14:00:00Z');
    expect(seenAgain({ pepperSeenAt: null, lastMessageAt }, now)).toBe(true);
    expect(seenAgain({ pepperSeenAt: at('2026-11-09T13:59:00Z'), lastMessageAt }, now)).toBe(true);
    expect(seenAgain({ pepperSeenAt: at('2026-11-09T14:30:00Z'), lastMessageAt }, now)).toBe(false);
    expect(seenAgain({ pepperSeenAt: at('2026-11-09T14:00:00Z'), lastMessageAt }, now)).toBe(true);
    expect(seenAgain({ pepperSeenAt: at('2026-11-09T14:00:01Z'), lastMessageAt }, now)).toBe(false);
  });
});
