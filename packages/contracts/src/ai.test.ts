import { describe, expect, it } from 'vitest';
import {
  LLM_TEXT_MAX,
  LlmMessageSchema,
  LlmRequestSchema,
  LlmResponseSchema,
  LlmToolDefinitionSchema,
  LlmToolNameSchema,
  RETRYABLE_LLM_ERRORS,
  type LlmRequestInput,
} from './ai.js';

const request = (overrides: Partial<LlmRequestInput> = {}): LlmRequestInput => ({
  route: 'routine',
  instructions: 'You are Pepper.',
  messages: [{ role: 'user', content: 'What does tomorrow look like?' }],
  tools: [],
  toolChoice: 'auto',
  maxOutputTokens: 800,
  ...overrides,
});

describe('LlmToolNameSchema (ADR-0027)', () => {
  it.each(['find_clients', 'create_booking', 'get_day', 'add_todo2'])('accepts %s', (name) => {
    expect(LlmToolNameSchema.safeParse(name).success).toBe(true);
  });

  it.each(['findClients', 'book', '_find', 'find__clients', 'find-clients', `a_${'b'.repeat(63)}`])(
    'refuses %s',
    (name) => {
      expect(LlmToolNameSchema.safeParse(name).success).toBe(false);
    },
  );
});

describe('LlmMessageSchema', () => {
  it('accepts the three roles', () => {
    expect(LlmMessageSchema.parse({ role: 'user', content: 'hi' })).toEqual({
      role: 'user',
      content: 'hi',
    });
    const assistant = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'find_clients', arguments: '{"query":"Maria"}' }],
      replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
    };
    expect(LlmMessageSchema.parse(assistant)).toEqual(assistant);
    const tool = { role: 'tool', toolCallId: 'call_1', content: '[]', isError: false };
    expect(LlmMessageSchema.parse(tool)).toEqual(tool);
  });

  it('refuses unknown roles, extra fields and oversized text', () => {
    expect(LlmMessageSchema.safeParse({ role: 'system', content: 'x' }).success).toBe(false);
    expect(
      LlmMessageSchema.safeParse({ role: 'user', content: 'x', tenantId: 'other' }).success,
    ).toBe(false);
    expect(
      LlmMessageSchema.safeParse({ role: 'user', content: 'x'.repeat(LLM_TEXT_MAX + 1) }).success,
    ).toBe(false);
  });
});

describe('LlmToolDefinitionSchema', () => {
  it('needs an object schema and a description', () => {
    const tool = {
      name: 'find_clients',
      description: 'Look clients up by name.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    };
    expect(LlmToolDefinitionSchema.parse(tool)).toEqual(tool);
    expect(
      LlmToolDefinitionSchema.safeParse({ ...tool, parameters: { type: 'string' } }).success,
    ).toBe(false);
    expect(LlmToolDefinitionSchema.safeParse({ ...tool, description: '' }).success).toBe(false);
  });
});

describe('LlmRequestSchema', () => {
  it('accepts a minimal request and the optional cache and safety ids', () => {
    expect(LlmRequestSchema.parse(request())).toEqual(request());
    expect(
      LlmRequestSchema.parse(request({ cacheKey: 'tenant-abc', safetyId: 'u-hash' })).cacheKey,
    ).toBe('tenant-abc');
  });

  it('needs a message, a route (never a model id) and bounded output', () => {
    expect(LlmRequestSchema.safeParse(request({ messages: [] })).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ ...request(), route: 'gpt-x' }).success).toBe(false);
    expect(LlmRequestSchema.safeParse({ ...request(), model: 'gpt-x' }).success).toBe(false);
    expect(LlmRequestSchema.safeParse(request({ maxOutputTokens: 0 })).success).toBe(false);
    expect(LlmRequestSchema.safeParse(request({ maxOutputTokens: 40_000 })).success).toBe(false);
  });
});

describe('LlmResponseSchema', () => {
  it('accepts a refusal with its text and refuses negative token counts', () => {
    const response = {
      text: '',
      toolCalls: [],
      replay: [],
      finishReason: 'refused',
      refusal: 'I can’t help with that.',
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
      model: 'model-a',
    };
    expect(LlmResponseSchema.parse(response)).toEqual(response);
    expect(
      LlmResponseSchema.safeParse({
        ...response,
        usage: { ...response.usage, outputTokens: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('RETRYABLE_LLM_ERRORS', () => {
  it('retries only transient failures', () => {
    expect([...RETRYABLE_LLM_ERRORS].sort()).toEqual(['rate_limited', 'timeout', 'unavailable']);
  });
});
