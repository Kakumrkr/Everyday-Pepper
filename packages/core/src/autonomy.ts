import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  AutonomyLevelSchema,
  AutonomyRequestSchema,
  BULK_RECIPIENT_LIMIT,
  type AutonomyAction,
  type AutonomyDecision,
  type AutonomyLevel,
  type AutonomyOutcome,
  type AutonomyRequest,
  type AutonomySettings,
  type BusinessAutonomy,
  type RiskTier,
} from '@pepper/contracts';

// The autonomy decision (ADR-0028, playbook principles 2 and 10): whether a write the AI wants
// to make runs at once, runs and tells the member, or waits as a proposal. Pure, so it is
// proven by property tests over every action × level × tier × context. Its input comes from the
// domain (the tool's declared actions and tier, the recipients its preview counted, whether the
// turn read untrusted text) and the business's settings, never from the model's arguments.
// Every rule can only make the outcome stricter, so the rules compose safely.

const TIER_RANK: Record<RiskTier, number> = {
  read: 0,
  internal_write: 1,
  external_or_irreversible: 2,
};
const LEVEL_RANK: Record<AutonomyLevel, number> = { ask: 0, notify: 1, auto: 2 };
const OUTCOME_OF: Record<AutonomyLevel, AutonomyOutcome> = {
  ask: 'propose',
  notify: 'execute_and_notify',
  auto: 'execute',
};

/** Decides how a write the AI wants to make goes ahead. Throws on a malformed request. */
export function decideAutonomy(
  request: AutonomyRequest,
  autonomy: BusinessAutonomy,
): AutonomyDecision {
  const {
    actions,
    tier: declared,
    recipients,
    untrustedContext,
    changesAutonomy,
  } = AutonomyRequestSchema.parse(request);

  // Changing what the AI may do without asking is never done without asking.
  if (changesAutonomy === true) return { outcome: 'propose', reason: 'autonomy_change' };

  // A tool is held to the strictest of its declared tier and its actions' tiers.
  const tier = actions
    .map((action) => AUTONOMY_ACTIONS[action].riskTier)
    .reduce<RiskTier>((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a), declared);
  if (tier === 'read') return { outcome: 'execute', reason: 'read_only' };

  // A write that names no action on the dial has no setting to follow: it asks.
  if (actions.length === 0) return { outcome: 'propose', reason: 'setting' };
  if (autonomy.askFirst) return { outcome: 'propose', reason: 'ask_first' };
  // What is remembered shapes later answers: after untrusted text a person confirms it
  // (playbook principle 5, S30).
  if (
    untrustedContext &&
    actions.some((action) => 'asksAfterUntrusted' in AUTONOMY_ACTIONS[action])
  ) {
    return { outcome: 'propose', reason: 'untrusted_context' };
  }

  if (tier === 'external_or_irreversible') {
    if (recipients > BULK_RECIPIENT_LIMIT) return { outcome: 'propose', reason: 'bulk_lock' };
    // Text the model read can't be trusted to have asked for something leaving the business.
    if (untrustedContext) return { outcome: 'propose', reason: 'untrusted_context' };
  }

  const level = actions
    .map((action) => levelOf(autonomy, action))
    .reduce((a, b) => (LEVEL_RANK[b] < LEVEL_RANK[a] ? b : a));
  // After untrusted text, a write is never quiet: the member sees it, with Undo.
  if (untrustedContext && level === 'auto') {
    return { outcome: 'execute_and_notify', reason: 'untrusted_context' };
  }
  return { outcome: OUTCOME_OF[level], reason: 'setting' };
}

/** The action's level, failing closed on one the action does not allow or a missing one. */
function levelOf(autonomy: BusinessAutonomy, action: AutonomyAction): AutonomyLevel {
  const level = AutonomyLevelSchema.safeParse(autonomy.levels[action]);
  if (!level.success) return 'ask';
  return allowed(action, level.data) ? level.data : 'ask';
}

function allowed(action: AutonomyAction, level: AutonomyLevel): boolean {
  return level !== 'auto' || AUTONOMY_ACTIONS[action].allowsAuto;
}

/**
 * A business's effective autonomy: its own level for an action, else its template's, else the
 * platform default; "Ask me first for everything" off unless it turned it on. Stored levels an
 * action does not allow (or unknown actions) fail closed: such a level becomes "ask me".
 */
export function resolveAutonomy(
  own: { askFirst: boolean; levels: AutonomySettings } | undefined,
  templateDefaults: AutonomySettings,
): BusinessAutonomy {
  const levels = {} as Record<AutonomyAction, AutonomyLevel>;
  for (const action of AutonomyActionSchema.options) {
    const chosen = own?.levels[action] ?? templateDefaults[action];
    if (chosen === undefined) {
      levels[action] = AUTONOMY_ACTIONS[action].defaultLevel;
      continue;
    }
    const level = AutonomyLevelSchema.safeParse(chosen);
    levels[action] = level.success && allowed(action, level.data) ? level.data : 'ask';
  }
  return { askFirst: own?.askFirst === true, levels };
}
