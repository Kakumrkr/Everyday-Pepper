import { z } from 'zod';

// Visit risk (S77, ADR-0071): how likely an upcoming visit is to be lost (a no-show or a late
// cancel), as a band with the reasons behind it. Computed by rules from booking behaviour only:
// never a name, age, gender, address or anything standing in for them. Shown to owners and
// managers only, like the no-show pattern.

export const VISIT_RISK_BANDS = ['low', 'medium', 'high'] as const;
export const VisitRiskBandSchema = z.enum(VISIT_RISK_BANDS);
export type VisitRiskBand = z.infer<typeof VisitRiskBandSchema>;

/** Every signal the rules read. A new signal is added here and to the signal-list test. */
export const VISIT_RISK_SIGNALS = [
  'missed_before',
  'first_visit',
  'booked_far_ahead',
  'online_no_deposit',
  'not_confirmed',
] as const;
export const VisitRiskSignalSchema = z.enum(VISIT_RISK_SIGNALS);
export type VisitRiskSignal = z.infer<typeof VisitRiskSignalSchema>;

const Points = z.number().int().min(1).max(10);
const Count = z.number().int().min(0).max(100_000);

/** One reason, with the counts it came from (no free text, so nothing personal can ride along). */
export const VisitRiskReasonSchema = z.discriminatedUnion('signal', [
  /** Missed `misses` (no-shows and late cancels) of their `visits` finished or missed visits. */
  z
    .object({ signal: z.literal('missed_before'), points: Points, misses: Count, visits: Count })
    .strict(),
  z.object({ signal: z.literal('first_visit'), points: Points }).strict(),
  /** Booked `days` before the visit. */
  z.object({ signal: z.literal('booked_far_ahead'), points: Points, days: Count }).strict(),
  z.object({ signal: z.literal('online_no_deposit'), points: Points }).strict(),
  z.object({ signal: z.literal('not_confirmed'), points: Points }).strict(),
]);
export type VisitRiskReason = z.infer<typeof VisitRiskReasonSchema>;

export const VisitRiskReasonsSchema = z.array(VisitRiskReasonSchema).max(VISIT_RISK_SIGNALS.length);

/** A visit's risk: the band, the points behind it and the reasons, most points first. */
export const VisitRiskSchema = z
  .object({
    band: VisitRiskBandSchema,
    points: z.number().int().min(0).max(20),
    reasons: VisitRiskReasonsSchema,
  })
  .strict();
export type VisitRisk = z.infer<typeof VisitRiskSchema>;

/**
 * A visit's risk as a *Why?* fact's flat value (`visit_risk`; facts hold scalars only): the
 * band, and one key per reason with its count. S78's confirm-or-release card records it.
 */
export function visitRiskFactValue(risk: VisitRisk): Record<string, string | number | boolean> {
  const value: Record<string, string | number | boolean> = { band: risk.band };
  for (const reason of risk.reasons) {
    switch (reason.signal) {
      case 'missed_before':
        value['misses'] = reason.misses;
        value['visits'] = reason.visits;
        break;
      case 'first_visit':
        value['firstVisit'] = true;
        break;
      case 'booked_far_ahead':
        value['daysAhead'] = reason.days;
        break;
      case 'online_no_deposit':
        value['onlineNoDeposit'] = true;
        break;
      case 'not_confirmed':
        value['notConfirmed'] = true;
        break;
    }
  }
  return value;
}

/**
 * The band and reasons back from a `visit_risk` fact's value, in the signal list's order (the
 * order of most points too: only a miss scores more than one); `null` for a value that isn't one.
 * Points are not kept in the fact, so each reason reads as its words only.
 */
export function visitRiskFromFact(
  value: unknown,
): { band: VisitRiskBand; signals: VisitRiskFactReason[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const band = VisitRiskBandSchema.safeParse(record['band']);
  if (!band.success) return null;
  const signals: VisitRiskFactReason[] = [];
  const misses = record['misses'];
  const visits = record['visits'];
  if (typeof misses === 'number' && typeof visits === 'number') {
    signals.push({ signal: 'missed_before', misses, visits });
  }
  if (record['firstVisit'] === true) signals.push({ signal: 'first_visit' });
  if (typeof record['daysAhead'] === 'number') {
    signals.push({ signal: 'booked_far_ahead', days: record['daysAhead'] });
  }
  if (record['onlineNoDeposit'] === true) signals.push({ signal: 'online_no_deposit' });
  if (record['notConfirmed'] === true) signals.push({ signal: 'not_confirmed' });
  return { band: band.data, signals };
}

/** A reason without its points: what a fact keeps and the screens word. */
export type VisitRiskFactReason =
  | { signal: 'missed_before'; misses: number; visits: number }
  | { signal: 'first_visit' | 'online_no_deposit' | 'not_confirmed' }
  | { signal: 'booked_far_ahead'; days: number };
