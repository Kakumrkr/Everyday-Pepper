import { z } from 'zod';

const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][\w.:-]{0,99}$/, 'Expected a model id');
/** How hard a route's model reasons before answering (Responses API `reasoning.effort`). */
const EffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ReasoningEffort = z.infer<typeof EffortSchema>;

const OpenAiEnvSchema = z
  .object({
    /** Unset: the AI is off and every screen works without it (AC-X-2). A secret. */
    OPENAI_API_KEY: z.string().min(20).max(500).optional(),
    /** The model behind each route (ADR-0027). Required with a key; chosen from evals (S27). */
    OPENAI_MODEL_ROUTINE: ModelIdSchema.optional(),
    OPENAI_MODEL_STRONG: ModelIdSchema.optional(),
    /** Each route's reasoning effort; unset: the model's default (chosen with the model, S27). */
    OPENAI_REASONING_ROUTINE: EffortSchema.optional(),
    OPENAI_REASONING_STRONG: EffortSchema.optional(),
    /** The embedding model for the memory's recall (Phase 7, ADR-0034); unset: no embeddings. */
    OPENAI_MODEL_EMBEDDING: ModelIdSchema.optional(),
    /** Another https endpoint for the same API (a proxy); unset: OpenAI's. */
    OPENAI_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  })
  .refine(
    (env) =>
      env.OPENAI_API_KEY === undefined ||
      (env.OPENAI_MODEL_ROUTINE !== undefined && env.OPENAI_MODEL_STRONG !== undefined),
    { message: 'Set OPENAI_MODEL_ROUTINE and OPENAI_MODEL_STRONG with OPENAI_API_KEY' },
  );

export interface OpenAiConfig {
  apiKey: string;
  models: { routine: string; strong: string };
  reasoning?: { routine?: ReasoningEffort; strong?: ReasoningEffort };
  /** The embedding model (ADR-0034); unset: memory search is off, facts still recall. */
  embeddingModel?: string;
  baseUrl?: string;
  timeoutMs: number;
}

/**
 * Reads the OpenAI settings once at start-up; `null` when no key is set (AI off). The error
 * names the invalid variables, never their values. Never log the result: it holds the key.
 */
export function loadOpenAiConfig(env: NodeJS.ProcessEnv): OpenAiConfig | null {
  // An empty variable (`OPENAI_API_KEY=` in a .env file) means unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = OpenAiEnvSchema.safeParse(present);
  if (!result.success) {
    const invalid = [
      ...new Set(
        result.error.issues.map((issue) =>
          issue.path.length > 0 ? issue.path.join('.') : issue.message,
        ),
      ),
    ];
    throw new Error(`Invalid OpenAI environment: ${invalid.join(', ')}`);
  }
  const parsed = result.data;
  if (
    parsed.OPENAI_API_KEY === undefined ||
    parsed.OPENAI_MODEL_ROUTINE === undefined ||
    parsed.OPENAI_MODEL_STRONG === undefined
  ) {
    return null;
  }
  return {
    apiKey: parsed.OPENAI_API_KEY,
    models: { routine: parsed.OPENAI_MODEL_ROUTINE, strong: parsed.OPENAI_MODEL_STRONG },
    ...((parsed.OPENAI_REASONING_ROUTINE !== undefined ||
      parsed.OPENAI_REASONING_STRONG !== undefined) && {
      reasoning: {
        ...(parsed.OPENAI_REASONING_ROUTINE !== undefined && {
          routine: parsed.OPENAI_REASONING_ROUTINE,
        }),
        ...(parsed.OPENAI_REASONING_STRONG !== undefined && {
          strong: parsed.OPENAI_REASONING_STRONG,
        }),
      },
    }),
    ...(parsed.OPENAI_MODEL_EMBEDDING !== undefined && {
      embeddingModel: parsed.OPENAI_MODEL_EMBEDDING,
    }),
    ...(parsed.OPENAI_BASE_URL !== undefined && { baseUrl: parsed.OPENAI_BASE_URL }),
    timeoutMs: parsed.OPENAI_TIMEOUT_MS,
  };
}
