import {
  PLATFORM_RULE_DEFAULTS,
  type LocalDate,
  type Rule,
  type RuleDefaults,
  type StaffMemberId,
} from '@floty/contracts';

// Which rule applies to a staff member (ADR-0016): their own rule, else the business's, else
// the industry template's default, else the platform default. Blackout windows add up: the
// business's closed days and the staff member's own both apply.

/** A blackout window: local dates in the business's time zone, both ends included. */
export interface Blackout {
  startDate: LocalDate;
  endDate: LocalDate;
}

/** The rules in force for one staff member. */
export interface ResolvedRules extends RuleDefaults {
  blackouts: Blackout[];
}

/**
 * The rules for `staffMemberId`, from the business's rules (`GET /v1/rules`) over the
 * template's defaults (missing values fall back to the platform's).
 */
export function resolveRules(
  rules: readonly Rule[],
  staffMemberId: StaffMemberId,
  templateDefaults: Partial<RuleDefaults> = {},
): ResolvedRules {
  const applies = rules.filter(
    (r) => r.staffMemberId === null || r.staffMemberId === staffMemberId,
  );
  // A staff member's rule wins over the business's.
  const pick = <T extends Rule['type']>(type: T) => {
    const ofType = applies.filter((r): r is Extract<Rule, { type: T }> => r.type === type);
    return ofType.find((r) => r.staffMemberId !== null) ?? ofType[0];
  };
  const defaults: RuleDefaults = { ...PLATFORM_RULE_DEFAULTS, ...templateDefaults };
  return {
    slotIntervalMinutes: pick('slot_interval')?.params.minutes ?? defaults.slotIntervalMinutes,
    minimumNoticeMinutes: pick('minimum_notice')?.params.minutes ?? defaults.minimumNoticeMinutes,
    maximumAdvanceDays: pick('maximum_advance')?.params.days ?? defaults.maximumAdvanceDays,
    maxBookingsPerDay: pick('max_bookings_per_day')?.params.count ?? defaults.maxBookingsPerDay,
    blackouts: applies
      .filter((r): r is Extract<Rule, { type: 'blackout_window' }> => r.type === 'blackout_window')
      .map((r) => ({ startDate: r.params.startDate, endDate: r.params.endDate })),
  };
}
