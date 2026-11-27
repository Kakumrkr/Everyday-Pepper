import { describe, expect, it } from 'vitest';
import {
  VisitRiskReasonSchema,
  VisitRiskSchema,
  visitRiskFactValue,
  visitRiskFromFact,
  type VisitRisk,
} from './visit-risk.js';

// S77 (ADR-0071): a visit's risk, its reasons and the flat `visit_risk` fact.

describe('VisitRiskSchema', () => {
  it('takes counts and days only: no free text rides along', () => {
    expect(
      VisitRiskReasonSchema.safeParse({ signal: 'first_visit', points: 1, note: 'Ana' }).success,
    ).toBe(false);
    expect(VisitRiskReasonSchema.safeParse({ signal: 'age', points: 1 }).success).toBe(false);
    expect(VisitRiskSchema.safeParse({ band: 'severe', points: 1, reasons: [] }).success).toBe(
      false,
    );
  });
});

describe('the visit_risk fact', () => {
  it('flattens every reason and reads it back in the signal order', () => {
    const risk: VisitRisk = {
      band: 'high',
      points: 7,
      reasons: [
        { signal: 'missed_before', points: 3, misses: 2, visits: 5 },
        { signal: 'first_visit', points: 1 },
        { signal: 'booked_far_ahead', points: 1, days: 21 },
        { signal: 'online_no_deposit', points: 1 },
        { signal: 'not_confirmed', points: 1 },
      ],
    };
    const value = visitRiskFactValue(risk);
    expect(Object.values(value).every((v) => typeof v !== 'object')).toBe(true);
    expect(visitRiskFromFact(value)).toEqual({
      band: 'high',
      signals: [
        { signal: 'missed_before', misses: 2, visits: 5 },
        { signal: 'first_visit' },
        { signal: 'booked_far_ahead', days: 21 },
        { signal: 'online_no_deposit' },
        { signal: 'not_confirmed' },
      ],
    });
  });

  it('is null for a value that is not one', () => {
    expect(visitRiskFromFact(null)).toBeNull();
    expect(visitRiskFromFact({ band: 'severe' })).toBeNull();
    expect(visitRiskFromFact({ band: 'low' })).toEqual({ band: 'low', signals: [] });
  });
});
