import { describe, expect, it } from 'vitest';
import { MATCH_LEASE_MS, matchRetryDelayMs } from './matcher.js';

describe('the matcher back-off (S37)', () => {
  it('waits 10 s, then doubles, so five attempts fit well inside AC-W5-1 retries', () => {
    expect([1, 2, 3, 4].map(matchRetryDelayMs)).toEqual([10_000, 20_000, 40_000, 80_000]);
    // A lease outlives one match (a few queries), so a second worker never runs it alongside.
    expect(MATCH_LEASE_MS).toBe(60_000);
  });
});
