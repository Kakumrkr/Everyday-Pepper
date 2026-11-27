import { visitRiskFromFact, type VisitRiskBand, type VisitRiskFactReason } from '@pepper/contracts';

// A visit's risk in words (S77, ADR-0071): the evening wrap's reason and the `visit_risk`
// fact's line under *Why?*. Owners and managers only see these.

const count = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** One reason, lower case so it reads after a time: "2:00 pm · missed 2 of 5 visits". */
export function visitRiskReasonLine(reason: VisitRiskFactReason): string {
  switch (reason.signal) {
    case 'missed_before':
      return `missed ${String(reason.misses)} of ${count(reason.visits, 'visit')}`;
    case 'first_visit':
      return 'first visit';
    case 'booked_far_ahead':
      return `booked ${String(reason.days)} days ahead`;
    case 'online_no_deposit':
      return 'booked online, no deposit';
    case 'not_confirmed':
      return 'not confirmed yet';
  }
}

const BAND_WORDS: Record<VisitRiskBand, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};

/**
 * The `visit_risk` fact (`visitRiskFactValue`) as a sentence: "I rated the risk of a missed
 * visit high: missed 2 of 5 visits, not confirmed yet." `null` when the value isn't one.
 */
export function visitRiskFactLine(value: unknown): string | null {
  const risk = visitRiskFromFact(value);
  if (risk === null) return null;
  const words = BAND_WORDS[risk.band];
  return risk.signals.length === 0
    ? `I rated the risk of a missed visit ${words}.`
    : `I rated the risk of a missed visit ${words}: ${risk.signals.map(visitRiskReasonLine).join(', ')}.`;
}
