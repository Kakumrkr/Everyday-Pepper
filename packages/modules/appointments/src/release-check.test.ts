import { describe, expect, it } from 'vitest';
import { releaseCheck, releaseTargetKey } from './services/release-check.js';

// The release card's rules (S78.2, AC-X-207, D-2): asked at least 12 h before the 24 h cut-off,
// still unconfirmed and booked, from the cut-off until the start.

const HOUR = 3_600_000;
const START = Date.UTC(2026, 11, 1, 19, 0);
const asking = { askToConfirm: true, confirmCutoffHours: 24, holdback: false } as const;
const visit = (over: Partial<Parameters<typeof releaseCheck>[0]> = {}) => ({
  status: 'confirmed',
  startsAt: new Date(START),
  clientConfirmedAt: null,
  // The 72 h ask.
  confirmAskedAt: new Date(START - 72 * HOUR),
  confirmHeldBackAt: null,
  ...over,
});
const atCutoff = START - 24 * HOUR;

describe('releaseCheck', () => {
  it('releases an asked, unconfirmed visit from the cut-off until the start', () => {
    expect(releaseCheck(visit(), asking, atCutoff)).toBe('ok');
    expect(releaseCheck(visit(), asking, START - HOUR)).toBe('ok');
    expect(releaseCheck(visit(), asking, atCutoff, START)).toBe('ok');
  });

  it('waits for the cut-off and stops at the start', () => {
    expect(releaseCheck(visit(), asking, atCutoff - 1)).toBe('before_cutoff');
    expect(releaseCheck(visit(), asking, START)).toBe('started');
  });

  it('needs the business to ask and the client to have been asked early enough', () => {
    expect(releaseCheck(visit(), { ...asking, askToConfirm: false }, atCutoff)).toBe('not_asking');
    expect(releaseCheck(visit({ confirmAskedAt: null }), asking, atCutoff)).toBe('not_asked');
    // Exactly 12 h before the cut-off is early enough; a minute later (a day-before ask) isn't.
    expect(
      releaseCheck(visit({ confirmAskedAt: new Date(atCutoff - 12 * HOUR) }), asking, atCutoff),
    ).toBe('ok');
    expect(
      releaseCheck(
        visit({ confirmAskedAt: new Date(atCutoff - 12 * HOUR + 60_000) }),
        asking,
        atCutoff,
      ),
    ).toBe('asked_late');
  });

  it('never releases a confirmed, cancelled or moved visit', () => {
    expect(
      releaseCheck(visit({ clientConfirmedAt: new Date(atCutoff - HOUR) }), asking, atCutoff),
    ).toBe('confirmed');
    expect(releaseCheck(visit({ status: 'cancelled' }), asking, atCutoff)).toBe('not_booked');
    expect(releaseCheck(visit(), asking, atCutoff, START + HOUR)).toBe('moved');
  });

  it('never releases a visit the holdback kept from its early ask (S78.3, AC-X-215)', () => {
    const held = visit({ confirmHeldBackAt: new Date(START - 72 * HOUR) });
    const holding = { ...asking, holdback: true };
    expect(releaseCheck(held, holding, atCutoff)).toBe('held_back');
    // Turned off, the mark no longer holds the visit back (review).
    expect(releaseCheck(held, asking, atCutoff)).toBe('ok');
    // Whatever asked it later, at any cut-off: a 12 h cut-off makes the day-before ask early
    // enough, and still no card.
    const asked = { ...held, confirmAskedAt: new Date(START - 24 * HOUR) };
    expect(releaseCheck(asked, { ...holding, confirmCutoffHours: 12 }, START - 12 * HOUR)).toBe(
      'held_back',
    );
    expect(
      releaseCheck(
        visit({ confirmAskedAt: new Date(START - 24 * HOUR) }),
        { ...asking, confirmCutoffHours: 12 },
        START - 12 * HOUR,
      ),
    ).toBe('ok');
  });

  it('follows the business’s cut-off (S78.3, AC-X-218)', () => {
    const twelve = { ...asking, confirmCutoffHours: 12 } as const;
    const fortyEight = { ...asking, confirmCutoffHours: 48 } as const;
    expect(releaseCheck(visit(), twelve, atCutoff)).toBe('before_cutoff');
    expect(releaseCheck(visit(), twelve, START - 12 * HOUR)).toBe('ok');
    expect(releaseCheck(visit(), fortyEight, START - 48 * HOUR)).toBe('ok');
    expect(releaseCheck(visit(), fortyEight, START - 48 * HOUR - 1)).toBe('before_cutoff');
    // At 48 h, the 72 h ask is 24 h ahead of it; one 12 h before the cut-off is the latest.
    expect(
      releaseCheck(
        visit({ confirmAskedAt: new Date(START - 60 * HOUR + 60_000) }),
        fortyEight,
        START - 48 * HOUR,
      ),
    ).toBe('asked_late');
  });

  it('keys one card per visit', () => {
    expect(releaseTargetKey('b1')).toBe('release:booking:b1');
  });
});
