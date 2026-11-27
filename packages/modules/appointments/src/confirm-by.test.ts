import { describe, expect, it } from 'vitest';
import { confirmByOf } from './services/notices.js';

// When a client is asked to confirm by (S78, AC-X-202): a day before the visit, while the
// business asks and the client hasn't, and never a time already gone.

const START = new Date('2026-11-20T15:00:00.000Z');
const BY = '2026-11-19T15:00:00.000Z';
const asking = { reminderSettings: { askToConfirm: true } };
const visit = { startsAt: START, clientConfirmedAt: null };

describe('confirmByOf', () => {
  it('is a day before the visit while the business asks', () => {
    expect(confirmByOf(asking, visit, Date.parse('2026-11-17T12:00:00Z'))).toBe(BY);
  });

  it('is nothing when the business doesn’t ask or the client confirmed', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    expect(confirmByOf({ reminderSettings: {} }, visit, now)).toBeNull();
    expect(confirmByOf(asking, { ...visit, clientConfirmedAt: new Date(now) }, now)).toBeNull();
  });

  it('follows the business’s cut-off (S78.3, AC-X-218)', () => {
    const now = Date.parse('2026-11-17T12:00:00Z');
    const at = (confirmCutoffHours: number) => ({
      reminderSettings: { askToConfirm: true, confirmCutoffHours },
    });
    expect(confirmByOf(at(12), visit, now)).toBe('2026-11-20T03:00:00.000Z');
    expect(confirmByOf(at(48), visit, now)).toBe('2026-11-18T15:00:00.000Z');
    // Passed at 48 h, still ahead at 12 h.
    const later = Date.parse('2026-11-19T00:00:00Z');
    expect(confirmByOf(at(48), visit, later)).toBeNull();
    expect(confirmByOf(at(12), visit, later)).toBe('2026-11-20T03:00:00.000Z');
  });

  it('names no time already gone: a visit booked under a day ahead', () => {
    expect(confirmByOf(asking, visit, Date.parse(BY))).toBeNull();
    expect(confirmByOf(asking, visit, Date.parse('2026-11-20T09:00:00Z'))).toBeNull();
  });
});
