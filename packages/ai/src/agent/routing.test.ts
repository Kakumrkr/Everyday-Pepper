import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { routeFor, STRONG_AFTER_INVALID_CALLS, STRONG_AFTER_STEP } from './routing.js';

// Routing (ADR-0030): property tests over every step, refusal count and budget state.

const inputs = fc.record({
  step: fc.integer({ min: 1, max: 99 }),
  invalidCalls: fc.integer({ min: 0, max: 50 }),
  budget: fc.constantFrom('ok' as const, 'soft' as const),
});

describe('routeFor', () => {
  it('starts every turn on the routine model', () => {
    expect(routeFor({ step: 1, invalidCalls: 0, budget: 'ok' })).toBe('routine');
  });

  it('keeps an ordinary four-step booking on the routine model (S27, calibrated on real runs)', () => {
    // Look up services, look up the client, propose, answer: a real model's usual booking.
    expect(STRONG_AFTER_STEP).toBe(4);
    for (const step of [1, 2, 3, 4]) {
      expect(routeFor({ step, invalidCalls: 0, budget: 'ok' })).toBe('routine');
    }
    expect(routeFor({ step: 5, invalidCalls: 0, budget: 'ok' })).toBe('strong');
  });

  it('never uses the stronger model past the soft budget', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        expect(routeFor({ ...input, budget: 'soft' })).toBe('routine');
      }),
    );
  });

  it('uses the stronger model exactly for a multi-step plan or repeated bad calls', () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const expected =
          input.budget === 'ok' &&
          (input.step > STRONG_AFTER_STEP || input.invalidCalls >= STRONG_AFTER_INVALID_CALLS)
            ? 'strong'
            : 'routine';
        expect(routeFor(input)).toBe(expected);
      }),
    );
  });

  it('only escalates as a turn goes on (more steps or refusals never step down)', () => {
    fc.assert(
      fc.property(inputs, fc.nat(5), fc.nat(5), (input, moreSteps, moreRefusals) => {
        const later = {
          ...input,
          step: Math.min(99, input.step + moreSteps),
          invalidCalls: input.invalidCalls + moreRefusals,
        };
        if (routeFor(input) === 'strong') expect(routeFor(later)).toBe('strong');
      }),
    );
  });
});
