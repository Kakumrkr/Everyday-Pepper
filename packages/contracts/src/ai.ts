import { z } from 'zod';

// The provider-neutral model of one exchange with an LLM (ADR-0027). `packages/ai` maps it to
// a provider's API (OpenAI's Responses API first); nothing outside `packages/ai` sees a
// provider's own types. The model never sees or chooses a business, user or role: those come
// from the session and stay with the caller (ADR-0005).

/**
 * Which kind of model answers (ADR-0004): `routine` for everyday turns, `strong` for multi-step
 * planning and extraction. The model ids behind each route are configuration.
 */
export const LlmRouteSchema = z.enum(['routine', 'strong']);
export type LlmRoute = z.infer<typeof LlmRouteSchema>;

/** A tool's name: `verb_noun` in snake case, as providers require (at most 64 characters). */
export const LlmToolNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/)
  .max(64);

/** A tool call id the provider assigned; echoed back with the tool's result. */
export const LlmToolCallIdSchema = z.string().min(1).max(200);

/** Message text. Generous, but bounded so a runaway prompt fails here rather than at the bill. */
export const LLM_TEXT_MAX = 100_000;
const LlmTextSchema = z.string().max(LLM_TEXT_MAX);

/**
 * Items a provider needs back unchanged in the next request (reasoning items with their
 * encrypted content, an assistant message's phase). Opaque JSON, never shown to anyone, read
 * only by the provider that wrote it.
 */
export const LlmReplaySchema = z.array(z.record(z.string(), z.unknown())).max(100);
export type LlmReplay = z.infer<typeof LlmReplaySchema>;

/**
 * A tool call as the model made it. `arguments` is the model's raw JSON text: the tool
 * registry parses it with the tool's own Zod schema before anything runs, so nothing trusts it
 * earlier.
 */
export const LlmToolCallSchema = z.strictObject({
  id: LlmToolCallIdSchema,
  name: LlmToolNameSchema,
  arguments: z.string().max(LLM_TEXT_MAX),
});
export type LlmToolCall = z.infer<typeof LlmToolCallSchema>;

export const LlmUserMessageSchema = z.strictObject({
  role: z.literal('user'),
  content: LlmTextSchema,
});

export const LlmAssistantMessageSchema = z.strictObject({
  role: z.literal('assistant'),
  content: LlmTextSchema,
  toolCalls: z.array(LlmToolCallSchema).max(32),
  replay: LlmReplaySchema,
});

/** The result of one tool call, for the model. `isError` marks a refused or failed call. */
export const LlmToolMessageSchema = z.strictObject({
  role: z.literal('tool'),
  toolCallId: LlmToolCallIdSchema,
  content: LlmTextSchema,
  isError: z.boolean(),
});

export const LlmMessageSchema = z.discriminatedUnion('role', [
  LlmUserMessageSchema,
  LlmAssistantMessageSchema,
  LlmToolMessageSchema,
]);
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

/**
 * A JSON Schema object describing a tool's arguments, in the strict form providers accept
 * (built by `strictToolParameters` in `packages/ai` from the tool's Zod schema).
 */
const JsonSchemaObjectSchema = z
  .record(z.string(), z.unknown())
  .refine((schema) => schema['type'] === 'object', { message: 'Expected an object schema' });

export const LlmToolDefinitionSchema = z.strictObject({
  name: LlmToolNameSchema,
  /** When to use the tool, when not to, and what its arguments mean: the model's only guide. */
  description: z.string().min(1).max(1024),
  parameters: JsonSchemaObjectSchema,
});
export type LlmToolDefinition = z.infer<typeof LlmToolDefinitionSchema>;

export const LlmToolChoiceSchema = z.enum(['auto', 'none', 'required']);
export type LlmToolChoice = z.infer<typeof LlmToolChoiceSchema>;

export const LlmRequestSchema = z.strictObject({
  route: LlmRouteSchema,
  /** The system prompt. Static text first, so the provider's prompt cache can reuse it. */
  instructions: LlmTextSchema,
  messages: z.array(LlmMessageSchema).min(1).max(200),
  tools: z.array(LlmToolDefinitionSchema).max(32),
  toolChoice: LlmToolChoiceSchema,
  maxOutputTokens: z.int().min(16).max(32_000),
  /** Routes requests that share a prefix to the same prompt cache (per business). */
  cacheKey: z.string().min(1).max(64).optional(),
  /** A stable hash of the user (never their id or email), for the provider's abuse detection. */
  safetyId: z.string().min(1).max(64).optional(),
});
export type LlmRequest = z.infer<typeof LlmRequestSchema>;
export type LlmRequestInput = z.input<typeof LlmRequestSchema>;

/**
 * Why the model stopped: it answered, it wants tools run, it hit the output limit, it refused,
 * or the provider's content filter stopped it.
 */
export const LlmFinishReasonSchema = z.enum([
  'stop',
  'tool_calls',
  'length',
  'refused',
  'content_filter',
]);
export type LlmFinishReason = z.infer<typeof LlmFinishReasonSchema>;

const TokenCountSchema = z.int().min(0);

/**
 * Tokens one answer used. `cachedInputTokens` is the part of the input read from the cache;
 * `cacheWriteTokens` the part written to it (billed at its own rate on newer models; absent
 * when none was written).
 */
export const LlmUsageSchema = z.strictObject({
  inputTokens: TokenCountSchema,
  cachedInputTokens: TokenCountSchema,
  cacheWriteTokens: TokenCountSchema.optional(),
  outputTokens: TokenCountSchema,
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export const LlmResponseSchema = z.strictObject({
  text: z.string(),
  toolCalls: z.array(LlmToolCallSchema),
  replay: LlmReplaySchema,
  finishReason: LlmFinishReasonSchema,
  /** The model's explanation when `finishReason` is `refused`. */
  refusal: z.string().optional(),
  usage: LlmUsageSchema,
  /** The model id that answered (for reports and cost), not chosen by the model. */
  model: z.string().min(1),
});
export type LlmResponse = z.infer<typeof LlmResponseSchema>;

/** A streamed answer: text as it arrives, then the whole response. */
export type LlmStreamEvent =
  { type: 'text_delta'; delta: string } | { type: 'done'; response: LlmResponse };

/**
 * Why a call failed, provider-neutral. `budget_exceeded` covers both the provider's quota and
 * (S25) a business's own monthly budget.
 */
export const LlmErrorCodeSchema = z.enum([
  'timeout',
  'rate_limited',
  'unavailable',
  'auth',
  'bad_request',
  'invalid_response',
  'aborted',
  'budget_exceeded',
]);
export type LlmErrorCode = z.infer<typeof LlmErrorCodeSchema>;

/** Failures worth another attempt (if the caller's time budget allows). */
export const RETRYABLE_LLM_ERRORS: ReadonlySet<LlmErrorCode> = new Set([
  'timeout',
  'rate_limited',
  'unavailable',
]);

/** At most this many texts in one embedding request, each at most `LLM_EMBED_TEXT_MAX` chars. */
export const LLM_EMBED_BATCH_MAX = 64;
export const LLM_EMBED_TEXT_MAX = 8_000;

/**
 * Texts to embed (Phase 7, ADR-0034): episode summaries when stored, a member's question when
 * searched. Like every request, without contacts (the callers redact them).
 */
export const LlmEmbeddingRequestSchema = z.strictObject({
  input: z.array(z.string().min(1).max(LLM_EMBED_TEXT_MAX)).min(1).max(LLM_EMBED_BATCH_MAX),
});
export type LlmEmbeddingRequest = z.infer<typeof LlmEmbeddingRequestSchema>;

/** One embedding per input, in order, with the tokens billed (no output tokens). */
export const LlmEmbeddingResponseSchema = z.strictObject({
  embeddings: z.array(z.array(z.number().finite()).min(1)).min(1).max(LLM_EMBED_BATCH_MAX),
  usage: LlmUsageSchema,
  model: z.string().min(1).max(200),
});
export type LlmEmbeddingResponse = z.infer<typeof LlmEmbeddingResponseSchema>;
