import { z } from 'zod';
import type { Permission } from './permissions.js';
import { UserIdSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

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
  'booking.cancel',
  'booking_request.accept',
  'time.block',
  'client_note.save',
  'task.create',
  'message.confirmation',
  'message.rebooking_nudge',
  'message.waitlist_offer',
  'message.bulk',
]);
export type AutonomyAction = z.infer<typeof AutonomyActionSchema>;

/**
 * How long an action the AI took can be undone (ADR-0028), fixed when it runs:
 * - `for`: this many minutes, and with `notAfterAppointmentStart` never once the appointment it
 *   touched has started (a booking can't be un-made after the client sat down);
 * - `until_sent`: a message can be taken back while it has not left (AI-queued client emails
 *   wait `AI_EMAIL_GRACE_SECONDS` first, so Undo really unsends them).
 */
export type UndoWindow =
  { kind: 'for'; minutes: number; notAfterAppointmentStart: boolean } | { kind: 'until_sent' };

const DAY = 24 * 60;
const BOOKING_UNDO: UndoWindow = { kind: 'for', minutes: DAY, notAfterAppointmentStart: true };
const UNTIL_SENT: UndoWindow = { kind: 'until_sent' };

/**
 * Each action's risk tier, the platform default (approved with the mockups, S2; `booking.cancel`
 * and `task.create` by PCR-003), whether "just do it" may be chosen at all (never for one
 * message to many clients), the permission a member needs to approve or undo it, and its undo
 * window.
 */
export const AUTONOMY_ACTIONS = {
  'booking.create': {
    riskTier: 'internal_write',
    defaultLevel: 'ask',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: BOOKING_UNDO,
  },
  'booking.move': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: BOOKING_UNDO,
  },
  // Undo restores the booking only while its time is still free and has not started.
  'booking.cancel': {
    riskTier: 'internal_write',
    defaultLevel: 'ask',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: BOOKING_UNDO,
  },
  'booking_request.accept': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: BOOKING_UNDO,
  },
  'time.block': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
    permission: 'time_off.manage',
    undo: { kind: 'for', minutes: DAY, notAfterAppointmentStart: false },
  },
  'client_note.save': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
    permission: 'client_notes.manage',
    undo: { kind: 'for', minutes: 7 * DAY, notAfterAppointmentStart: false },
  },
  'task.create': {
    riskTier: 'internal_write',
    defaultLevel: 'notify',
    allowsAuto: true,
    permission: 'tasks.manage',
    undo: { kind: 'for', minutes: 7 * DAY, notAfterAppointmentStart: false },
  },
  'message.confirmation': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'auto',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: UNTIL_SENT,
  },
  'message.rebooking_nudge': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'ask',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: UNTIL_SENT,
  },
  'message.waitlist_offer': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'ask',
    allowsAuto: true,
    permission: 'bookings.manage',
    undo: UNTIL_SENT,
  },
  'message.bulk': {
    riskTier: 'external_or_irreversible',
    defaultLevel: 'ask',
    allowsAuto: false,
    permission: 'clients.manage',
    undo: UNTIL_SENT,
  },
} as const satisfies Record<
  AutonomyAction,
  {
    riskTier: RiskTier;
    defaultLevel: AutonomyLevel;
    allowsAuto: boolean;
    permission: Permission;
    undo: UndoWindow;
  }
>;

/** More recipients than this make a message bulk: it always asks first (AC-W7-3). */
export const BULK_RECIPIENT_LIMIT = 10;

/** AI-queued client emails wait this long before they go, so Undo can unsend them (ADR-0028). */
export const AI_EMAIL_GRACE_SECONDS = 120;

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

/**
 * A business's autonomy, as the Autonomy settings page shows it: the level of every action
 * (its own choice, else its template's, else the platform default) and the "Ask me first for
 * everything" switch, which makes every write wait for approval while it is on.
 */
export const BusinessAutonomySchema = z
  .object({
    askFirst: z.boolean(),
    levels: z.record(AutonomyActionSchema, AutonomyLevelSchema),
  })
  .strict();
export type BusinessAutonomy = z.infer<typeof BusinessAutonomySchema>;

/**
 * A change to a business's autonomy: the switch, and levels per action (`null`: back to the
 * template's or platform default). "Just do it" is refused where it is not allowed.
 */
export const AutonomyChangeSchema = z
  .object({
    askFirst: z.boolean().optional(),
    levels: z
      .partialRecord(AutonomyActionSchema, AutonomyLevelSchema.nullable())
      .refine(
        (levels) =>
          Object.entries(levels).every(
            ([action, level]) =>
              level !== 'auto' || AUTONOMY_ACTIONS[action as AutonomyAction].allowsAuto,
          ),
        { message: '"Just do it" is not allowed for this action' },
      )
      .optional(),
  })
  .strict();
export type AutonomyChange = z.infer<typeof AutonomyChangeSchema>;

// ---------------------------------------------------------------------------------------------
// Decisions (ADR-0028). `decideAutonomy` in @pepper/core turns an action, the business's
// settings and what the domain knows about the turn into one of these. Nothing in its input
// comes from the model's arguments.

/**
 * What happens to a write the AI wants to make: run it quietly (a receipt in the activity),
 * run it and tell the member (a "done for you" card with Undo), or propose it and wait.
 */
export const AutonomyOutcomeSchema = z.enum(['execute', 'execute_and_notify', 'propose']);
export type AutonomyOutcome = z.infer<typeof AutonomyOutcomeSchema>;

/**
 * Why, as a stable code the *Why?* sheet can explain: reading needs no permission; the
 * business's setting; "Ask me first for everything" is on; a message to more than
 * `BULK_RECIPIENT_LIMIT` clients; the turn read untrusted text (a client's note, a booking
 * message) before an external action, or before a quiet write; changing autonomy itself.
 */
export const AutonomyReasonSchema = z.enum([
  'read_only',
  'setting',
  'ask_first',
  'bulk_lock',
  'untrusted_context',
  'autonomy_change',
]);
export type AutonomyReason = z.infer<typeof AutonomyReasonSchema>;

/**
 * What the domain knows about one tool call, for `decideAutonomy`: the dial actions it involves
 * (a move that emails the client is `booking.move` and `message.confirmation`; none for a
 * read), the tier the tool declares (the actions' own tiers apply if stricter), the clients a
 * message would reach as its preview counted them, whether the turn read untrusted text (a
 * client's note, a booking-page message), and whether it changes the autonomy settings.
 */
export const AutonomyRequestSchema = z
  .object({
    actions: z.array(AutonomyActionSchema).max(AutonomyActionSchema.options.length),
    tier: RiskTierSchema,
    recipients: z.number().int().min(0),
    untrustedContext: z.boolean(),
    changesAutonomy: z.boolean().optional(),
  })
  .strict();
export type AutonomyRequest = z.input<typeof AutonomyRequestSchema>;

export const AutonomyDecisionSchema = z
  .object({ outcome: AutonomyOutcomeSchema, reason: AutonomyReasonSchema })
  .strict();
export type AutonomyDecision = z.infer<typeof AutonomyDecisionSchema>;

// ---------------------------------------------------------------------------------------------
// Action records (ADR-0028): proposals waiting for a member, and executions with their undo.

export const ActionProposalIdSchema = z.uuid().toLowerCase().brand<'ActionProposalId'>();
export type ActionProposalId = z.infer<typeof ActionProposalIdSchema>;

export const ActionExecutionIdSchema = z.uuid().toLowerCase().brand<'ActionExecutionId'>();
export type ActionExecutionId = z.infer<typeof ActionExecutionIdSchema>;

/**
 * A proposal waits (`pending`) until a member approves or rejects it, it expires, or a newer
 * proposal for the same thing (or a fresh preview after the world changed) supersedes it.
 */
export const ProposalStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'expired',
  'superseded',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/** An execution is `done` until it is undone. */
export const ExecutionStatusSchema = z.enum(['done', 'undone']);
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

/** Why a member undid an action: feeds the wrong-action rate (vision metric, < 1%). */
export const UndoReasonSchema = z.enum(['wrong', 'changed_mind', 'other']);
export type UndoReason = z.infer<typeof UndoReasonSchema>;

/** A tool's name (`verb_noun`, S24) or another stable code. */
export const TrustCodeSchema = z.string().regex(/^[a-z][a-z0-9_.:-]{0,63}$/, 'A lowercase code');

/**
 * The fingerprint of what a member was shown (SHA-256, lowercase hex): the payload, the state
 * the preview read and the would-be messages. Approval recomputes it; a mismatch is stale.
 */
export const StateFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/, 'A SHA-256 hex digest');
export type StateFingerprint = z.infer<typeof StateFingerprintSchema>;

/** Names one AI action across retries: `(conversation, turn, tool call)` from S25. */
export const ActionIdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9.:_-]{8,200}$/, 'Use letters, digits and .:_- only');

/** Names what a proposal changes (e.g. `booking:<id>`); one pending proposal per target. */
export const ActionTargetKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9.:_-]{1,200}$/, 'Use letters, digits and .:_- only');

/** Largest stored payload, preview, before/after, inverse or explanation, as JSON. */
export const TRUST_JSON_MAX_BYTES = 8192;
const TRUST_JSON_MAX_DEPTH = 8;

const EMAIL_LIKE = /[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]{2,}/;
// Ids, dates and times are digits and dashes too: they are taken out before looking for a
// phone number (7 or more digits with only spaces, dots, dashes, brackets or a plus between).
const NOT_A_PHONE = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g,
  /\d{1,2}:\d{2}(?::\d{2})?/g,
];
const PHONE_LIKE = /\+?\d(?:[\s().-]{0,3}\d){6,}/;

/** Whether `text` looks like it holds an email address or a phone number. */
export function looksLikeContact(text: string): boolean {
  if (EMAIL_LIKE.test(text)) return true;
  const rest = NOT_A_PHONE.reduce((value, pattern) => value.replace(pattern, ' '), text);
  return PHONE_LIKE.test(rest);
}

const encoder = new TextEncoder();

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

function checkJson(value: unknown, depth: number, issues: string[]): void {
  if (depth > TRUST_JSON_MAX_DEPTH) {
    issues.push('nested too deeply');
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push('a number that is not finite');
    return;
  }
  if (typeof value === 'string') {
    if (looksLikeContact(value)) issues.push('an email address or phone number');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, depth + 1, issues);
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (looksLikeContact(key)) issues.push('an email address or phone number');
      checkJson(item, depth + 1, issues);
    }
    return;
  }
  issues.push('a value that is not JSON');
}

/**
 * JSON stored with an AI action (payload, preview, before/after, inverse, explanation parts):
 * ids, times, codes and the member's own short texts, at most `TRUST_JSON_MAX_BYTES`, and never
 * a client's email address or phone number (PII stays in the client's record; a defence in
 * depth behind each tool's own strict schema).
 */
export const TrustJsonSchema = z.custom<Json>().superRefine((value, ctx) => {
  const issues: string[] = [];
  checkJson(value, 0, issues);
  for (const issue of new Set(issues)) {
    ctx.addIssue({ code: 'custom', message: `Holds ${issue}` });
  }
  if (issues.length > 0) return;
  if (jsonBytes(value) > TRUST_JSON_MAX_BYTES) {
    ctx.addIssue({ code: 'custom', message: `Larger than ${String(TRUST_JSON_MAX_BYTES)} bytes` });
  }
});
export type TrustJson = Json;

/**
 * *Why?* (playbook principle 9), assembled from facts, never from model prose: the member's
 * message it answered (by id, S25), the tools called with their inputs, the rules and facts
 * used, the alternatives offered, whether untrusted text was in the turn, and the autonomy
 * decision.
 */
export const ActionExplanationSchema = z
  .object({
    requestMessageId: z.uuid().nullable(),
    steps: z.array(z.object({ tool: TrustCodeSchema, input: TrustJsonSchema }).strict()).max(10),
    facts: z
      .array(
        z
          .object({ kind: TrustCodeSchema, ref: z.uuid().nullable(), value: TrustJsonSchema })
          .strict(),
      )
      .max(20),
    alternatives: z.array(TrustJsonSchema).max(5),
    untrustedContext: z.boolean(),
    decision: AutonomyDecisionSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (jsonBytes(value) > TRUST_JSON_MAX_BYTES) {
      ctx.addIssue({
        code: 'custom',
        message: `Larger than ${String(TRUST_JSON_MAX_BYTES)} bytes`,
      });
    }
  });
export type ActionExplanation = z.infer<typeof ActionExplanationSchema>;

/** A proposal as the services return it (the chat card and, later, the feed). */
export const ActionProposalSchema = z
  .object({
    id: ActionProposalIdSchema,
    action: AutonomyActionSchema,
    tool: TrustCodeSchema,
    targetKey: ActionTargetKeySchema,
    status: ProposalStatusSchema,
    payload: TrustJsonSchema,
    preview: TrustJsonSchema,
    fingerprint: StateFingerprintSchema,
    explanation: ActionExplanationSchema,
    requestedByUserId: UserIdSchema.nullable(),
    recordOwnerUserId: UserIdSchema.nullable(),
    decidedByUserId: UserIdSchema.nullable(),
    decidedAt: UtcDateTimeSchema.nullable(),
    expiresAt: UtcDateTimeSchema,
    createdAt: UtcDateTimeSchema,
  })
  .strict();
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

/** An executed action, its receipt and its undo. */
export const ActionExecutionSchema = z
  .object({
    id: ActionExecutionIdSchema,
    proposalId: ActionProposalIdSchema.nullable(),
    action: AutonomyActionSchema,
    tool: TrustCodeSchema,
    outcome: AutonomyOutcomeSchema,
    status: ExecutionStatusSchema,
    entity: z.object({ type: TrustCodeSchema, id: z.uuid() }).strict(),
    before: TrustJsonSchema,
    after: TrustJsonSchema,
    explanation: ActionExplanationSchema,
    outboxMessageIds: z.array(z.uuid()).max(100),
    onBehalfOfUserId: UserIdSchema.nullable(),
    recordOwnerUserId: UserIdSchema.nullable(),
    undoUntil: UtcDateTimeSchema.nullable(),
    undoneByUserId: UserIdSchema.nullable(),
    undoneAt: UtcDateTimeSchema.nullable(),
    undoReason: UndoReasonSchema.nullable(),
    createdAt: UtcDateTimeSchema,
  })
  .strict();
export type ActionExecution = z.infer<typeof ActionExecutionSchema>;
