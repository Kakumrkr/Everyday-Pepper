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

/**
 * The actions on the autonomy dial (the Autonomy settings page, docs/mockups): what the AI may
 * do with or without asking. Reading ("check availability, look up clients") is always allowed
 * and is not on the dial. Each tool (Phase 6) names one of these as its `actionType`.
 */
export const AutonomyActionSchema = z.enum([
  'booking.create',
  'booking.move',
  'booking_request.accept',
  'time.block',
  'client_note.save',
  'message.confirmation',
  'message.rebooking_nudge',
  'message.waitlist_offer',
  'message.bulk',
]);
export type AutonomyAction = z.infer<typeof AutonomyActionSchema>;

/**
 * Each action's risk tier, the platform default (approved with the mockups, S2) and whether
 * "just do it" may be chosen at all: never for one message to more than 10 clients.
 */
export const AUTONOMY_ACTIONS = {
  'booking.create': { riskTier: 'internal_write', defaultLevel: 'ask', allowsAuto: true },
  'booking.move': { riskTier: 'internal_write', defaultLevel: 'notify', allowsAuto: true },
  'booking_request.accept': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
  },
  'time.block': { riskTier: 'internal_write', defaultLevel: 'notify', allowsAuto: true },
  'client_note.save': { riskTier: 'internal_write', defaultLevel: 'notify', allowsAuto: true },
  'message.confirmation': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'auto',
    allowsAuto: true,
  },
  'message.rebooking_nudge': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'ask',
    allowsAuto: true,
  },
  'message.waitlist_offer': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'ask',
    allowsAuto: true,
  },
  'message.bulk': { riskTier: 'external_or_irreversible', defaultLevel: 'ask', allowsAuto: false },
} as const satisfies Record<
  AutonomyAction,
  { riskTier: RiskTier; defaultLevel: AutonomyLevel; allowsAuto: boolean }
>;

/**
 * Autonomy levels for some actions (an industry template's defaults, later a business's own
 * choices); the others keep their platform default. "Just do it" is refused where it is not
 * allowed.
 */
export const AutonomySettingsSchema = z
  .partialRecord(AutonomyActionSchema, AutonomyLevelSchema)
  .refine(
    (settings) =>
      Object.entries(settings).every(
        ([action, level]) =>
          level !== 'auto' || AUTONOMY_ACTIONS[action as AutonomyAction].allowsAuto,
      ),
    { message: '"Just do it" is not allowed for this action' },
  );
export type AutonomySettings = z.infer<typeof AutonomySettingsSchema>;
