import type { LlmRoute } from '@pepper/contracts';

// Model routing (ADR-0030, playbook principle 12): routine turns on the small model, the
// stronger one only by rule. The rules see only what the loop counted, never the model's
// say-so, and a business past its soft budget stays on the routine model.

/** A turn's step after which it counts as a multi-step plan. */
export const STRONG_AFTER_STEP = 3;
/** Refused calls for bad arguments or unknown tools after which the turn needs the stronger model. */
export const STRONG_AFTER_INVALID_CALLS = 2;

export interface RouteInput {
  /** The step about to be asked (1 for the turn's first model call). */
  step: number;
  /** This turn's calls refused as `invalid_arguments` or `unknown_tool` so far. */
  invalidCalls: number;
  /** The business's token budget after reserving this call. */
  budget: 'ok' | 'soft';
}

/** Which model answers the next step. */
export function routeFor(input: RouteInput): LlmRoute {
  if (input.budget === 'soft') return 'routine';
  if (input.invalidCalls >= STRONG_AFTER_INVALID_CALLS) return 'strong';
  if (input.step > STRONG_AFTER_STEP) return 'strong';
  return 'routine';
}
