import { z } from 'zod';
import { ClientIdSchema } from './clients.js';
import { MemoryFactShownSchema } from './memory.js';
import { LocalDateSchema } from './rules.js';
import {
  ChangeSideSchema,
  ToolCardSchema,
  ToolErrorCodeSchema,
  WouldBeEmailSchema,
} from './tool-cards.js';
import {
  ActionExecutionIdSchema,
  ActionProposalIdSchema,
  AutonomyActionSchema,
  AutonomyDecisionSchema,
  AutonomyOutcomeSchema,
  ExecutionStatusSchema,
  looksLikeContact,
  ProposalStatusSchema,
  StateFingerprintSchema,
  TrustCodeSchema,
  UndoReasonSchema,
} from './trust.js';
import { UtcDateTimeSchema } from './time.js';

// What a member sees of the AI's proposals and actions (S26, ADR-0031): the live state behind a
// chat card (a stored card is a snapshot; this is what is true now), the *Why?* sheet, and the
// answers of Approve, Reject and Undo. Everything here is assembled from the trust layer's
// records, never from model prose; ids, local times, display names and codes only.

/** One sentence written by a tool's code (never the model's text), without a contact. */
const ToolSummarySchema = z
  .string()
  .max(600)
  .refine((text) => !looksLikeContact(text), 'Holds an email address or phone number');

/** A change side as the views show it: the card's shape, and never a contact. */
const SafeSideSchema = ChangeSideSchema.refine(
  (side) =>
    Object.entries(side).every(
      ([key, value]) =>
        !looksLikeContact(key) && (typeof value !== 'string' || !looksLikeContact(value)),
    ),
  'Holds an email address or phone number',
);

/**
 * What started the action, for *Why?*: the member's own message (only ever to the member who
 * wrote it; conversations are their own), `not_shown` when it is someone else's or was deleted
 * after 90 days, `none` when no message started it.
 */
export const WhyAskedSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), text: z.string().max(4_000) }),
  z.strictObject({ kind: z.literal('not_shown') }),
  z.strictObject({ kind: z.literal('none') }),
]);
export type WhyAsked = z.infer<typeof WhyAskedSchema>;

/**
 * A fact the tool's code checked on the way (S26b: "the time was free", "2 bookings stay
 * inside it"): a code and a flat value (local dates and times, display names, counts), never
 * a contact. The screens word it; an unknown code is not shown.
 */
export const AiWhyFactSchema = z.strictObject({
  kind: TrustCodeSchema,
  value: SafeSideSchema.nullable(),
});
export type AiWhyFact = z.infer<typeof AiWhyFactSchema>;

/** *Why?* (playbook principle 9): the request, the tools used, the dial's decision. */
export const AiWhySchema = z.strictObject({
  asked: WhyAskedSchema,
  steps: z.array(z.strictObject({ tool: TrustCodeSchema })).max(10),
  decision: AutonomyDecisionSchema,
  /** The turn held text a client typed: external actions asked first, quiet writes told you. */
  untrustedContext: z.boolean(),
  /** What the domain checked (S26b). Optional: actions recorded before S26b have none. */
  facts: z.array(AiWhyFactSchema).max(20).optional(),
  /**
   * The remembered facts it used (S30), read live by id: "a fact you deleted" once gone.
   * Optional: actions recorded before S30 have none.
   */
  remembered: z.array(MemoryFactShownSchema).max(20).optional(),
});
export type AiWhy = z.infer<typeof AiWhySchema>;

/** Where an email the AI queued is now: held for Undo, gone, taken back, or failed to send. */
export const AiEmailStatusSchema = z.enum(['waiting', 'sent', 'taken_back', 'failed']);
export type AiEmailStatus = z.infer<typeof AiEmailStatusSchema>;

export const AiEmailViewSchema = z.strictObject({
  template: WouldBeEmailSchema.shape.template,
  clientId: ClientIdSchema,
  status: AiEmailStatusSchema,
  /** When a waiting email leaves (the undo-send grace); `null` once it has left or won't. */
  sendsAt: UtcDateTimeSchema.nullable(),
});
export type AiEmailView = z.infer<typeof AiEmailViewSchema>;

/**
 * What a card shows from memory (S30), read live by id: the fact a memory tool saves or
 * forgets ("Updated: was …"), the booking's warnings (AC-W3-2: an allergy on a color service)
 * and the client's last visit with its notes. Only what the viewer may read; nothing deleted.
 */
export const AiMemoryViewSchema = z.strictObject({
  fact: MemoryFactShownSchema.nullable(),
  warnings: z.array(MemoryFactShownSchema).max(10),
  lastVisit: z
    .strictObject({
      date: LocalDateSchema,
      serviceName: z.string().max(120),
      notes: z.array(MemoryFactShownSchema).max(10),
    })
    .nullable(),
});
export type AiMemoryView = z.infer<typeof AiMemoryViewSchema>;

/** `GET /v1/ai/proposals/:id`: a proposal as it stands now. */
export const AiProposalViewSchema = z.strictObject({
  id: ActionProposalIdSchema,
  action: AutonomyActionSchema,
  tool: TrustCodeSchema,
  status: ProposalStatusSchema,
  /** What the member approves with: the card shows exactly this preview. */
  fingerprint: StateFingerprintSchema,
  summary: ToolSummarySchema,
  before: SafeSideSchema.nullable(),
  after: SafeSideSchema.nullable(),
  emails: z.array(WouldBeEmailSchema).max(20),
  expiresAt: UtcDateTimeSchema,
  createdAt: UtcDateTimeSchema,
  /** The receipt, once approved. */
  executionId: ActionExecutionIdSchema.nullable(),
  /** Who approved or turned it down, when it was someone other than the viewer. */
  decidedByName: z.string().max(80).nullable(),
  /** It was made for the viewer (their own request). */
  forYou: z.boolean(),
  /** The viewer may approve or reject it now (it is pending and theirs to decide). */
  canDecide: z.boolean(),
  why: AiWhySchema,
  /** Memory on the card (S30); absent when there is none. */
  memory: AiMemoryViewSchema.optional(),
});
export type AiProposalView = z.infer<typeof AiProposalViewSchema>;

/** `GET /v1/ai/actions/:id`: a receipt ("Done for you") as it stands now. */
export const AiActionViewSchema = z.strictObject({
  id: ActionExecutionIdSchema,
  proposalId: ActionProposalIdSchema.nullable(),
  action: AutonomyActionSchema,
  tool: TrustCodeSchema,
  outcome: AutonomyOutcomeSchema,
  status: ExecutionStatusSchema,
  /** `null` for receipts recorded before S26 kept the summary. */
  summary: ToolSummarySchema.nullable(),
  before: SafeSideSchema.nullable(),
  after: SafeSideSchema.nullable(),
  emails: z.array(AiEmailViewSchema).max(100),
  createdAt: UtcDateTimeSchema,
  undoUntil: UtcDateTimeSchema.nullable(),
  /** The window is open, it is done, and the viewer may undo it. */
  canUndo: z.boolean(),
  undoneAt: UtcDateTimeSchema.nullable(),
  undoReason: UndoReasonSchema.nullable(),
  /** A lead approved it for the member who asked (S23 log: the receipt is theirs too). */
  approvedByName: z.string().max(80).nullable(),
  /** It was done for, or asked for by, the viewer. */
  forYou: z.boolean(),
  why: AiWhySchema,
  /** Memory on the card (S30); absent when there is none. */
  memory: AiMemoryViewSchema.optional(),
});
export type AiActionView = z.infer<typeof AiActionViewSchema>;

/** `GET /v1/ai/actions`: the AI's recent actions the viewer may see, newest first. */
export const AiActionsResponseSchema = z.strictObject({ actions: z.array(AiActionViewSchema) });
export type AiActionsResponse = z.infer<typeof AiActionsResponseSchema>;

/** `GET /v1/ai/proposals`: proposals waiting for the viewer's OK, oldest first. */
export const AiProposalsResponseSchema = z.strictObject({
  proposals: z.array(AiProposalViewSchema),
});
export type AiProposalsResponse = z.infer<typeof AiProposalsResponseSchema>;

/**
 * `POST /v1/ai/proposals/:id/approve`: the fingerprint the card showed, and nothing else. The
 * stored proposal is what runs, never a payload the browser sends.
 */
export const ApproveProposalRequestSchema = z.strictObject({ fingerprint: StateFingerprintSchema });
export type ApproveProposalRequest = z.infer<typeof ApproveProposalRequestSchema>;

/**
 * What approving came to: done (the receipt); `stale` (the world or the tool changed since the
 * card was shown: here is the fresh proposal to show, nothing ran); `refused` (the domain now
 * says no, with the tool's stable code and, for a taken time, the nearest free ones); `expired`.
 */
export const ApproveProposalResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('executed'), action: AiActionViewSchema }),
  z.strictObject({ kind: z.literal('stale'), proposal: AiProposalViewSchema }),
  z.strictObject({
    kind: z.literal('refused'),
    code: ToolErrorCodeSchema,
    message: z.string().max(300),
    card: ToolCardSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('expired') }),
]);
export type ApproveProposalResponse = z.infer<typeof ApproveProposalResponseSchema>;

/** `POST /v1/ai/actions/:id/undo`: why, for the wrong-action metric (optional). */
export const UndoActionRequestSchema = z.strictObject({ reason: UndoReasonSchema.nullable() });
export type UndoActionRequest = z.infer<typeof UndoActionRequestSchema>;

/** The receipt after Undo, and its emails: taken back, or already gone ("already emailed"). */
export const UndoActionResponseSchema = z.strictObject({
  action: AiActionViewSchema,
  takenBack: z.int().min(0),
  alreadySent: z.int().min(0),
});
export type UndoActionResponse = z.infer<typeof UndoActionResponseSchema>;

/** Why an undo with an open window was refused (the world moved on). */
export const UndoRefusalSchema = z.enum([
  'slot_taken',
  'already_started',
  'already_sent',
  'changed_since',
  'not_possible',
]);
export type UndoRefusal = z.infer<typeof UndoRefusalSchema>;

/** 409 `undo_refused`. */
export const UndoRefusedBodySchema = z.strictObject({
  code: z.literal('undo_refused'),
  message: z.string(),
  reason: UndoRefusalSchema,
});
export type UndoRefusedBody = z.infer<typeof UndoRefusedBodySchema>;

/**
 * `GET /v1/chat/status`: whether the AI can answer now: `on`; `off` (not set up on this server);
 * `paused` (the business's monthly allowance is used up). Every screen works in all three.
 */
export const ChatStatusSchema = z.strictObject({ state: z.enum(['on', 'off', 'paused']) });
export type ChatStatus = z.infer<typeof ChatStatusSchema>;
