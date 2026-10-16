import { z } from 'zod';

/**
 * Risk tier every AI tool declares (docs/architecture/ai-agent-and-trust-layer.md).
 * The tier bounds which autonomy levels a tenant may choose for the action.
 */
export const RiskTierSchema = z.enum(['read', 'internal_write', 'external_or_irreversible']);
export type RiskTier = z.infer<typeof RiskTierSchema>;

/**
 * Autonomy dial per action type: "ask me" / "do it and tell me" / "just do it".
 */
export const AutonomyLevelSchema = z.enum(['ask', 'notify', 'auto']);
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;
