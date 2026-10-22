import { describe, expect, it } from 'vitest';
import { loadOpenAiConfig } from './config.js';

const KEY = 'sk-test-0123456789abcdefghij';
const MODELS = { OPENAI_MODEL_ROUTINE: 'small-model-1', OPENAI_MODEL_STRONG: 'big-model.2' };

describe('loadOpenAiConfig (ADR-0027)', () => {
  it('is off without a key (empty counts as unset), models or not', () => {
    expect(loadOpenAiConfig({})).toBeNull();
    expect(loadOpenAiConfig({ OPENAI_API_KEY: '', ...MODELS })).toBeNull();
  });

  it('reads the key, both routes, the timeout and an optional https base url', () => {
    expect(loadOpenAiConfig({ OPENAI_API_KEY: KEY, ...MODELS })).toEqual({
      apiKey: KEY,
      models: { routine: 'small-model-1', strong: 'big-model.2' },
      timeoutMs: 30_000,
    });
    expect(
      loadOpenAiConfig({
        OPENAI_API_KEY: KEY,
        ...MODELS,
        OPENAI_BASE_URL: 'https://proxy.example/v1',
        OPENAI_TIMEOUT_MS: '15000',
      }),
    ).toMatchObject({ baseUrl: 'https://proxy.example/v1', timeoutMs: 15_000 });
  });

  it('needs both models with a key: they are chosen from evals, there are no defaults', () => {
    expect(() =>
      loadOpenAiConfig({ OPENAI_API_KEY: KEY, OPENAI_MODEL_ROUTINE: 'small-model-1' }),
    ).toThrow('Set OPENAI_MODEL_ROUTINE and OPENAI_MODEL_STRONG with OPENAI_API_KEY');
  });

  it('reads an optional reasoning effort per route (unset: the model default, S27)', () => {
    expect(
      loadOpenAiConfig({ OPENAI_API_KEY: KEY, ...MODELS, OPENAI_REASONING_ROUTINE: 'low' }),
    ).toMatchObject({ reasoning: { routine: 'low' } });
    expect(loadOpenAiConfig({ OPENAI_API_KEY: KEY, ...MODELS })).not.toHaveProperty('reasoning');
    expect(() =>
      loadOpenAiConfig({ OPENAI_API_KEY: KEY, ...MODELS, OPENAI_REASONING_STRONG: 'turbo' }),
    ).toThrow('Invalid OpenAI environment: OPENAI_REASONING_STRONG');
  });

  it('names invalid variables without echoing their values', () => {
    const attempt = () =>
      loadOpenAiConfig({
        OPENAI_API_KEY: 'short-secret',
        ...MODELS,
        OPENAI_BASE_URL: 'http://plain.example',
        OPENAI_TIMEOUT_MS: '10',
      });
    expect(attempt).toThrow(
      'Invalid OpenAI environment: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_TIMEOUT_MS',
    );
    expect(attempt).not.toThrow('short-secret');
    expect(() =>
      loadOpenAiConfig({ OPENAI_API_KEY: KEY, ...MODELS, OPENAI_MODEL_STRONG: 'a b' }),
    ).toThrow('OPENAI_MODEL_STRONG');
  });
});
