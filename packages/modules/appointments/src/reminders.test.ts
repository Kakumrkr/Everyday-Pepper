import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { reminderDueAt } from './services/reminders.js';

// When reminders are due (S62, AC-X-70): the day before at 24 h, the same day at the lead, both
// kept out of the night in the business's zone; the same-day one on the start's own day only.

const NY = 'America/New_York';
const HOUR = 3_600_000;
/** `HH:MM` New York time (EST, UTC-5) on `day` November 2026. */
const ny = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return Date.UTC(2026, 10, day, (h ?? 0) + 5, m ?? 0);
};
const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
  ...DEFAULT_REMINDER_SETTINGS,
  ...over,
});

describe('reminderDueAt: the day before', () => {
  it('is 24 hours ahead during the day', () => {
    expect(reminderDueAt('day_before', ny(17, '14:00'), NY, settings())).toBe(ny(16, '14:00'));
    expect(reminderDueAt('day_before', ny(17, '19:59'), NY, settings())).toBe(ny(16, '19:59'));
  });

  it('moves from 20:00 on to 19:30, and before 8:00 to 8:00', () => {
    expect(reminderDueAt('day_before', ny(17, '20:00'), NY, settings())).toBe(ny(16, '19:30'));
    expect(reminderDueAt('day_before', ny(17, '23:45'), NY, settings())).toBe(ny(16, '19:30'));
    expect(reminderDueAt('day_before', ny(17, '06:30'), NY, settings())).toBe(ny(16, '08:00'));
    expect(reminderDueAt('day_before', ny(17, '00:15'), NY, settings())).toBe(ny(16, '08:00'));
  });

  it('follows the business’s zone, not the server’s', () => {
    // 09:00 in Los Angeles is 17:00 UTC; the day before at 09:00 there.
    const start = Date.UTC(2026, 10, 17, 17, 0);
    expect(reminderDueAt('day_before', start, 'America/Los_Angeles', settings())).toBe(
      start - 24 * HOUR,
    );
    // 06:00 in Los Angeles: moved to 08:00 there (16:00 UTC), not 08:00 UTC.
    const early = Date.UTC(2026, 10, 17, 14, 0);
    expect(reminderDueAt('day_before', early, 'America/Los_Angeles', settings())).toBe(
      Date.UTC(2026, 10, 16, 16, 0),
    );
  });

  it('is kept on a daylight-saving day (8 March 2026: 2:00 → 3:00 in New York)', () => {
    // Monday 9 March 10:00 EDT (14:00 UTC); 24 h before is Sunday 10:00 EDT.
    const start = Date.UTC(2026, 2, 9, 14, 0);
    expect(reminderDueAt('day_before', start, NY, settings())).toBe(start - 24 * HOUR);
  });

  it('is none when the business turned it off', () => {
    expect(reminderDueAt('day_before', ny(17, '14:00'), NY, settings({ dayBefore: false }))).toBe(
      null,
    );
  });
});

describe('reminderDueAt: the same day', () => {
  it('is the lead ahead (1, 2 or 3 hours)', () => {
    expect(reminderDueAt('same_day', ny(17, '14:00'), NY, settings())).toBe(ny(17, '12:00'));
    expect(reminderDueAt('same_day', ny(17, '14:00'), NY, settings({ sameDayLeadHours: 1 }))).toBe(
      ny(17, '13:00'),
    );
    expect(reminderDueAt('same_day', ny(17, '14:00'), NY, settings({ sameDayLeadHours: 3 }))).toBe(
      ny(17, '11:00'),
    );
  });

  it('waits for 8:00 on an early visit, and drops a visit too early for any notice', () => {
    expect(reminderDueAt('same_day', ny(17, '09:00'), NY, settings())).toBe(ny(17, '08:00'));
    expect(reminderDueAt('same_day', ny(17, '08:30'), NY, settings())).toBe(ny(17, '08:00'));
    // 8:00 leaves 20 minutes before an 8:20 visit: under 30, so none.
    expect(reminderDueAt('same_day', ny(17, '08:20'), NY, settings())).toBeNull();
    expect(reminderDueAt('same_day', ny(17, '07:00'), NY, settings())).toBeNull();
  });

  it('goes at 19:30 for a late visit, and never the evening before', () => {
    expect(reminderDueAt('same_day', ny(17, '22:30'), NY, settings())).toBe(ny(17, '19:30'));
    // A visit at 00:30: two hours before is the evening before, so none.
    expect(reminderDueAt('same_day', ny(18, '00:30'), NY, settings())).toBeNull();
  });

  it('is none when the same-day text or texts are off', () => {
    expect(reminderDueAt('same_day', ny(17, '14:00'), NY, settings({ sameDay: false }))).toBeNull();
    expect(reminderDueAt('same_day', ny(17, '14:00'), NY, settings({ texts: false }))).toBeNull();
  });
});
