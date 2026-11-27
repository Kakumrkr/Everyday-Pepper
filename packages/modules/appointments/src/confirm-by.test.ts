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

  it('names no time already gone: a visit booked under a day ahead', () => {
    expect(confirmByOf(asking, visit, Date.parse(BY))).toBeNull();
    expect(confirmByOf(asking, visit, Date.parse('2026-11-20T09:00:00Z'))).toBeNull();
  });
});
