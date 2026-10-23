import { EMBEDDING_DIMENSIONS } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { embedderContract } from '../embedder-contract.js';
import { OpenAiEmbedder } from './openai-embedder.js';
import { errorBody, fakeOpenAiFetch, type FakeOpenAiAnswer } from './test-fixtures.js';

const KEY = 'sk-test-0123456789abcdefghij';

/** An embeddings answer shaped like OpenAI's documented `CreateEmbeddingResponse`. */
function embeddingsBody(count: number, options: { reversed?: boolean; size?: number } = {}) {
  const data = Array.from({ length: count }, (_, index) => ({
    object: 'embedding',
    index,
    embedding: Array.from({ length: options.size ?? EMBEDDING_DIMENSIONS }, (_, i) =>
      i === index ? 0.5 : 0.001,
    ),
  }));
  return {
    object: 'list',
    data: options.reversed === true ? data.reverse() : data,
    model: 'text-embedding-3-small',
    usage: { prompt_tokens: 9 * count, total_tokens: 9 * count },
  };
}

function embedder(answers: FakeOpenAiAnswer[], timeoutMs = 5_000) {
  const fake = fakeOpenAiFetch(answers);
  return {
    embedder: new OpenAiEmbedder({
      apiKey: KEY,
      model: 'text-embedding-3-small',
      baseUrl: 'https://openai.test/v1',
      timeoutMs,
      fetch: fake.fetch,
    }),
    requests: fake.requests,
  };
}

embedderContract('OpenAiEmbedder', {
  embedder: (texts) => embedder([{ kind: 'json', body: embeddingsBody(texts.length) }]).embedder,
});

describe('OpenAiEmbedder', () => {
  it('asks for floats at the stored size, with the configured model', async () => {
    const { embedder: subject, requests } = embedder([{ kind: 'json', body: embeddingsBody(1) }]);
    await subject.embed({ input: ['Maria wants a gloss.'] });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://openai.test/v1/embeddings');
    expect(requests[0]?.body).toEqual({
      model: 'text-embedding-3-small',
      input: ['Maria wants a gloss.'],
      encoding_format: 'float',
      dimensions: EMBEDDING_DIMENSIONS,
    });
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  });

  it('puts the answers back in input order', async () => {
    const { embedder: subject } = embedder([
      { kind: 'json', body: embeddingsBody(2, { reversed: true }) },
    ]);
    const { embeddings } = await subject.embed({ input: ['first', 'second'] });
    expect(embeddings[0]?.[0]).toBe(0.5);
    expect(embeddings[1]?.[1]).toBe(0.5);
  });

  it('refuses an answer of another size', async () => {
    const { embedder: subject } = embedder([
      { kind: 'json', body: embeddingsBody(1, { size: 512 }) },
    ]);
    await expect(subject.embed({ input: ['x'] })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it.each([
    [429, null, 'rate_limited'],
    [429, 'insufficient_quota', 'budget_exceeded'],
    [401, null, 'auth'],
    [400, null, 'bad_request'],
    [503, null, 'unavailable'],
  ] as const)(
    'maps HTTP %i (%s) to %s, without the provider text',
    async (status, code, mapped) => {
      const { embedder: subject } = embedder([
        { kind: 'json', status, body: errorBody('secret detail from provider', code) },
      ]);
      const error: unknown = await subject.embed({ input: ['x'] }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: mapped });
      expect((error as Error).message).not.toContain('secret detail');
    },
  );

  it('maps a network failure, its timeout and a cancel', async () => {
    await expect(
      embedder([{ kind: 'network_error' }]).embedder.embed({ input: ['x'] }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      embedder([{ kind: 'hang' }], 1_000).embedder.embed({ input: ['x'] }),
    ).rejects.toMatchObject({ code: 'timeout' });
    const controller = new AbortController();
    const pending = embedder([{ kind: 'hang' }]).embedder.embed(
      { input: ['x'] },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
  });
});
