import { describe, expect, it } from 'vitest';
import { BARBERS, BRIEFING, MARCUS, SERVICES, VISITS } from './southside';

// The gallery's made-up shop must add up like a real one (S39 retro): the briefing's numbers
// are today's visits, and every visit is on the menu at the menu's price.
describe('Southside Cuts', () => {
  it('books $430 over 12 visits today', () => {
    expect(VISITS).toHaveLength(BRIEFING.visits);
    expect(VISITS.reduce((sum, visit) => sum + visit.cents, 0)).toBe(BRIEFING.bookedCents);
  });

  it('prices every visit from the menu, with a barber of the shop', () => {
    for (const visit of VISITS) {
      const service = SERVICES.find((s) => s.name === visit.service);
      expect(service?.cents, visit.client).toBe(visit.cents);
      expect(BARBERS.map((b) => b.key)).toContain(visit.barber);
    }
  });

  it('shows money in whole cents', () => {
    for (const cents of [...SERVICES.map((s) => s.cents), MARCUS.spentCents]) {
      expect(Number.isInteger(cents)).toBe(true);
    }
  });
});
