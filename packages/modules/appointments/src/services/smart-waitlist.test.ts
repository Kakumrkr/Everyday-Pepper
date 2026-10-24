import { describe, expect, it } from 'vitest';
import { newOfferToken, offerTokenHash, stillOfferable } from './smart-waitlist.js';

const at = (iso: string) => new Date(iso);

describe('stillOfferable (S37, playbook principle 10)', () => {
  it('offers a time whose offers stay open at least 15 minutes', () => {
    // Offers close an hour before the slot: at 13:00 for a 14:00 slot.
    expect(stillOfferable(at('2026-11-03T14:00:00Z'), at('2026-11-03T12:45:00Z'))).toBe(true);
    expect(stillOfferable(at('2026-11-03T14:00:00Z'), at('2026-11-03T12:46:00Z'))).toBe(false);
    expect(stillOfferable(at('2026-11-03T14:00:00Z'), at('2026-11-03T13:30:00Z'))).toBe(false);
  });

  it('a slot days away is offered (for two hours)', () => {
    expect(stillOfferable(at('2026-11-06T14:00:00Z'), at('2026-11-03T12:00:00Z'))).toBe(true);
  });
});

describe('claim link secrets', () => {
  it('are 256 random bits; only a SHA-256 hex digest is stored', () => {
    const a = newOfferToken();
    const b = newOfferToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(offerTokenHash(a.token)).toBe(a.hash);
    expect(a.hash).not.toContain(a.token);
  });
});
