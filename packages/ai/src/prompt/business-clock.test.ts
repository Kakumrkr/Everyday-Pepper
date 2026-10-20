import { describe, expect, it } from 'vitest';
import { businessClock } from './business-clock.js';

describe('businessClock', () => {
  it('uses the business date, not UTC: 11:30 PM in New York is still the same day', () => {
    const clock = businessClock(new Date('2026-10-21T03:30:00Z'), 'America/New_York', 3);
    expect(clock).toBe(
      [
        'Now: Tuesday, October 20, 2026 at 11:30 PM (America/New_York).',
        'Dates in the business time zone: Tue 2026-10-20 (today); Wed 2026-10-21 (tomorrow); Thu 2026-10-22.',
      ].join('\n'),
    );
  });

  it('lists 14 days by default and crosses month ends and the DST change', () => {
    const clock = businessClock(new Date('2026-10-28T16:00:00Z'), 'America/Los_Angeles');
    expect(clock).toContain('Wed 2026-10-28 (today)');
    expect(clock).toContain('Sun 2026-11-01');
    expect(clock).toContain('Tue 2026-11-10.');
    expect(clock.split('; ')).toHaveLength(14);
  });
});
