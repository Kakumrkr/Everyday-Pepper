import { StateFingerprintSchema } from '@pepper/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson, stateFingerprint, type FingerprintParts } from './fingerprint.js';

const parts = (overrides: Partial<FingerprintParts> = {}): FingerprintParts => ({
  tool: 'move_booking',
  toolVersion: 1,
  payload: { bookingId: '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b', startsAt: '2026-10-23T16:00:00Z' },
  state: { booking: { updatedAt: '2026-10-21T09:00:00.000Z', status: 'confirmed' } },
  messages: [{ template: 'booking.moved', clientId: '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7c' }],
  ...overrides,
});

/** The same JSON value with every object's keys in a shuffled order. */
function shuffledKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item, i) => shuffledKeys(item, seed + i));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const order = entries
      .map((entry, i) => ({ entry, key: ((i + 1) * 2654435761 + seed) % 4294967296 }))
      .sort((a, b) => a.key - b.key)
      .map(({ entry: [k, v] }) => [k, shuffledKeys(v, seed + 7)] as const);
    return Object.fromEntries(order);
  }
  return value;
}

describe('stateFingerprint', () => {
  it('is a SHA-256 hex digest', () => {
    expect(StateFingerprintSchema.safeParse(stateFingerprint(parts())).success).toBe(true);
  });

  it('does not depend on the order of object keys (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), fc.integer(), (payload, state, seed) => {
        expect(stateFingerprint(parts({ payload, state }))).toBe(
          stateFingerprint(
            parts({ payload: shuffledKeys(payload, seed), state: shuffledKeys(state, seed + 1) }),
          ),
        );
      }),
    );
  });

  it('changes with any change to the payload, the state or the messages (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
        fc.pre(canonicalJson(a) !== canonicalJson(b));
        expect(stateFingerprint(parts({ payload: a }))).not.toBe(
          stateFingerprint(parts({ payload: b })),
        );
        expect(stateFingerprint(parts({ state: a }))).not.toBe(
          stateFingerprint(parts({ state: b })),
        );
        expect(stateFingerprint(parts({ messages: a }))).not.toBe(
          stateFingerprint(parts({ messages: b })),
        );
      }),
    );
  });

  it('keeps the parts apart: moving a value from one part to another changes it', () => {
    expect(stateFingerprint(parts({ payload: { x: 1 }, state: {} }))).not.toBe(
      stateFingerprint(parts({ payload: {}, state: { x: 1 } })),
    );
  });

  it('changes when the tool or its version changes', () => {
    const base = stateFingerprint(parts());
    expect(stateFingerprint(parts({ tool: 'cancel_booking' }))).not.toBe(base);
    expect(stateFingerprint(parts({ toolVersion: 2 }))).not.toBe(base);
  });

  it('notices a booking that changed after it was previewed', () => {
    expect(
      stateFingerprint(
        parts({
          state: { booking: { updatedAt: '2026-10-21T09:05:00.000Z', status: 'confirmed' } },
        }),
      ),
    ).not.toBe(stateFingerprint(parts()));
  });

  it('refuses values that are not plain JSON instead of hashing them loosely', () => {
    for (const bad of [undefined, Number.NaN, Infinity, new Date(), () => 1, new Map(), 10n]) {
      expect(() => stateFingerprint(parts({ state: { bad } }))).toThrow();
    }
  });
});

describe('canonicalJson', () => {
  it('sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }, 'x'] })).toBe(
      '{"a":[{"c":3,"d":2},"x"],"b":1}',
    );
  });

  it('round-trips to an equal value (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
      }),
    );
  });
});
