import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareCandidates,
  rankCandidates,
  windowsHold,
  type WaitlistCandidate,
} from './waitlist-ranking.js';

const JESS = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001';
const MARCO = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700002';
const NY = 'America/New_York';

function candidate(
  id: string,
  staffMemberId: string | null,
  joined: string,
  visits = 0,
): WaitlistCandidate {
  return { entryId: id, staffMemberId, createdAt: new Date(joined), visits };
}

describe('rankCandidates (S37, playbook principle 10)', () => {
  it('ranks asking for the staff member first, then waiting longest, then visits', () => {
    const ranked = rankCandidates(
      [
        candidate('a', null, '2026-10-01T10:00:00Z', 9),
        candidate('b', JESS, '2026-10-20T10:00:00Z', 0),
        candidate('c', null, '2026-09-01T10:00:00Z', 0),
        candidate('d', null, '2026-09-01T10:00:00Z', 4),
      ],
      JESS,
      3,
    );
    expect(ranked.map((r) => [r.candidate.entryId, r.fit, r.rank])).toEqual([
      ['b', 'asked_for_staff', 1],
      ['d', 'anyone', 2],
      ['c', 'anyone', 3],
    ]);
  });

  it('never offers a slot to an entry for another staff member', () => {
    const ranked = rankCandidates([candidate('m', MARCO, '2026-01-01T00:00:00Z', 50)], JESS, 3);
    expect(ranked).toEqual([]);
  });

  const arbitraryCandidate = fc.record({
    entryId: fc.uuid(),
    staffMemberId: fc.constantFrom(null, JESS, MARCO),
    createdAt: fc.date({
      min: new Date('2026-01-01T00:00:00Z'),
      max: new Date('2026-12-31T00:00:00Z'),
      noInvalidDate: true,
    }),
    visits: fc.nat({ max: 100 }),
  });

  it('is a deterministic total order: any input order gives the same ranking', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(arbitraryCandidate, { selector: (c) => c.entryId, maxLength: 20 })
          .chain((list) =>
            fc.tuple(fc.constant(list), fc.shuffledSubarray(list, { minLength: list.length })),
          ),
        fc.integer({ min: 1, max: 5 }),
        ([candidates, shuffled], fanOut) => {
          const ids = (list: WaitlistCandidate[]) =>
            rankCandidates(list, JESS, fanOut).map((r) => r.candidate.entryId);
          expect(ids(shuffled)).toEqual(ids(candidates));
        },
      ),
    );
  });

  it('offers at most fanOut, ranked 1..n, only eligible entries, each better than the next', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(arbitraryCandidate, { selector: (c) => c.entryId, maxLength: 20 }),
        fc.integer({ min: 1, max: 5 }),
        (candidates, fanOut) => {
          const ranked = rankCandidates(candidates, JESS, fanOut);
          const eligible = candidates.filter((c) => c.staffMemberId !== MARCO);
          expect(ranked.length).toBe(Math.min(fanOut, eligible.length));
          ranked.forEach((r, i) => {
            expect(r.rank).toBe(i + 1);
            expect(r.candidate.staffMemberId).not.toBe(MARCO);
            const next = ranked[i + 1];
            if (next !== undefined) {
              expect(compareCandidates(r.candidate, next.candidate, JESS)).toBeLessThan(0);
            }
          });
          // Nobody left out ranks better than the last one offered.
          const last = ranked.at(-1);
          const offered = new Set(ranked.map((r) => r.candidate.entryId));
          for (const c of eligible) {
            if (last !== undefined && !offered.has(c.entryId)) {
              expect(compareCandidates(c, last.candidate, JESS)).toBeGreaterThan(0);
            }
          }
        },
      ),
    );
  });
});

describe('windowsHold', () => {
  const windows = [{ date: '2026-11-07', start: '09:00', end: '12:00' }];
  // 2026-11-07 is a Saturday, EST (UTC-5).
  const at = (utc: string) => Date.parse(utc);

  it('holds an appointment inside a window, in the business time zone', () => {
    expect(windowsHold(windows, NY, at('2026-11-07T14:00:00Z'), 45)).toBe(true);
    expect(windowsHold(windows, NY, at('2026-11-07T16:15:00Z'), 45)).toBe(true);
  });

  it('does not hold one that starts before or runs past the window', () => {
    expect(windowsHold(windows, NY, at('2026-11-07T13:30:00Z'), 45)).toBe(false);
    expect(windowsHold(windows, NY, at('2026-11-07T16:30:00Z'), 45)).toBe(false);
    expect(windowsHold(windows, NY, at('2026-11-08T14:00:00Z'), 45)).toBe(false);
  });

  it('reads windows across a DST change by local time', () => {
    // 2026-11-01: clocks go back in New York; 9:00 local is 14:00 UTC (EST).
    const sunday = [{ date: '2026-11-01', start: '09:00', end: '10:00' }];
    expect(windowsHold(sunday, NY, at('2026-11-01T14:00:00Z'), 60)).toBe(true);
    expect(windowsHold(sunday, NY, at('2026-11-01T13:00:00Z'), 60)).toBe(false);
  });
});
