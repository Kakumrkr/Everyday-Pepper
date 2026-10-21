import { z } from 'zod';
import { UtcDateTimeSchema } from './time.js';
import { ToolCardSchema, ToolErrorCodeSchema } from './tool-cards.js';

// Chat with the AI (ADR-0030): a member's conversations, the turn they start with a message,
// and the typed events a turn streams (`POST /v1/chat/turns`, server-sent events, playbook
// §3.13–3.14). The agent works on turns, not on HTTP: the same events serve the chat screen
// (S26) and later voice (`channel`). No event carries the business, the member or a client's
// contact details.

export const ConversationIdSchema = z.uuid().toLowerCase().brand<'ConversationId'>();
export type ConversationId = z.infer<typeof ConversationIdSchema>;

export const ConversationTurnIdSchema = z.uuid().toLowerCase().brand<'ConversationTurnId'>();
export type ConversationTurnId = z.infer<typeof ConversationTurnIdSchema>;

export const ConversationMessageIdSchema = z.uuid().toLowerCase().brand<'ConversationMessageId'>();
export type ConversationMessageId = z.infer<typeof ConversationMessageIdSchema>;

/** Where a conversation happens: the chat screen now, voice later (V2). */
export const ChatChannelSchema = z.enum(['chat', 'voice']);
export type ChatChannel = z.infer<typeof ChatChannelSchema>;

/** The longest message a member can send in one turn. */
export const CHAT_MESSAGE_MAX = 4_000;

/**
 * `POST /v1/chat/turns`. `clientTurnId` is the client's idempotency key: sending the same one
 * again (a retry, a second tab) reattaches to that turn and never runs it twice.
 * `conversationId` `null` starts a new conversation.
 */
export const ChatTurnRequestSchema = z.strictObject({
  clientTurnId: z.uuid().toLowerCase(),
  conversationId: ConversationIdSchema.nullable(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX),
});
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

/**
 * How a turn ended. `answered` is the normal end; every other reason comes with the
 * deterministic fallback reply (playbook §3.13), never with a model's guess.
 */
export const TurnStopReasonSchema = z.enum([
  'answered',
  /** The turn used its steps, time or writes. */
  'step_limit',
  'time_limit',
  'write_limit',
  /** The model could not be reached, kept failing, or stopped itself. */
  'provider_unavailable',
  'provider_refused',
  /** The business's monthly AI allowance is used up (the screens keep working). */
  'budget_exhausted',
  /** The AI is switched off on this server (no provider configured). */
  'ai_off',
  'cancelled',
  /** The server stopped during the turn; what was done is recorded, nothing ran twice. */
  'interrupted',
  'internal',
]);
export type TurnStopReason = z.infer<typeof TurnStopReasonSchema>;

export const TurnStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled']);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

/** A screen in the app the fallback points to (relative links only). */
export const ScreenLinkSchema = z.strictObject({
  label: z.string().min(1).max(40),
  href: z.string().regex(/^\/[a-z0-9/-]*$/),
});
export type ScreenLink = z.infer<typeof ScreenLinkSchema>;

/** The reply when the AI can't answer: what happened, in plain words, and where to go. */
export const ChatFallbackSchema = z.strictObject({
  reason: TurnStopReasonSchema.exclude(['answered']),
  text: z.string().min(1).max(600),
  link: ScreenLinkSchema.nullable(),
});
export type ChatFallback = z.infer<typeof ChatFallbackSchema>;

/** What a tool call came to, for the member (never the model's raw arguments). */
export const ToolCallStatusSchema = z.enum(['answered', 'done', 'awaiting_approval', 'refused']);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

/** One event of a turn. The SSE `event:` field is `type`; `data:` is the JSON of the event. */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('turn.started'),
    conversationId: ConversationIdSchema,
    turnId: ConversationTurnIdSchema,
    requestMessageId: ConversationMessageIdSchema,
  }),
  z.strictObject({ type: z.literal('text.delta'), delta: z.string().min(1).max(4_000) }),
  z.strictObject({
    type: z.literal('tool.started'),
    tool: z.string().max(64),
    step: z.int().min(1).max(99),
  }),
  z.strictObject({
    type: z.literal('tool.finished'),
    tool: z.string().max(64),
    status: ToolCallStatusSchema,
    /** Short, spoken-friendly (voice readiness). */
    summary: z.string().max(600),
    /** For a refusal: the stable code (never the error's text). */
    code: ToolErrorCodeSchema.nullable(),
    card: ToolCardSchema.nullable(),
  }),
  z.strictObject({
    type: z.literal('message.completed'),
    messageId: ConversationMessageIdSchema,
    text: z.string().max(100_000),
  }),
  z.strictObject({ type: z.literal('turn.completed'), reason: z.literal('answered') }),
  z.strictObject({ type: z.literal('turn.failed'), fallback: ChatFallbackSchema }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** An event with its position in the turn (the SSE `id:`, for `Last-Event-ID` resume). */
export const ChatEventEnvelopeSchema = z.strictObject({
  seq: z.int().min(1),
  event: ChatEventSchema,
});
export type ChatEventEnvelope = z.infer<typeof ChatEventEnvelopeSchema>;

/** Whether a turn's events have ended (the stream closes after one of these). */
export function isFinalChatEvent(event: ChatEvent): boolean {
  return event.type === 'turn.completed' || event.type === 'turn.failed';
}

/** `GET /v1/chat/conversations`: the member's own conversations, newest first. */
export const ConversationSummarySchema = z.strictObject({
  id: ConversationIdSchema,
  channel: ChatChannelSchema,
  lastMessageAt: UtcDateTimeSchema,
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationsResponseSchema = z.strictObject({
  conversations: z.array(ConversationSummarySchema),
});

/** One item of a conversation as the member sees it: their words, the AI's, and cards. */
export const ChatHistoryItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    id: ConversationMessageIdSchema,
    text: z.string(),
    createdAt: UtcDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('assistant'),
    id: ConversationMessageIdSchema,
    text: z.string(),
    createdAt: UtcDateTimeSchema,
  }),
  z.strictObject({
    kind: z.literal('tool'),
    id: ConversationMessageIdSchema,
    tool: z.string().max(64),
    card: ToolCardSchema.nullable(),
    createdAt: UtcDateTimeSchema,
  }),
]);
export type ChatHistoryItem = z.infer<typeof ChatHistoryItemSchema>;

export const ChatHistoryResponseSchema = z.strictObject({
  conversationId: ConversationIdSchema,
  items: z.array(ChatHistoryItemSchema),
});
export type ChatHistoryResponse = z.infer<typeof ChatHistoryResponseSchema>;
