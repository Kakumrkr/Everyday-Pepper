import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingSchema,
  MemoryEpisodeInputSchema,
  MemoryFactChangeSchema,
  MemoryFactInputSchema,
  MemoryFactKeySchema,
  MemoryFactOriginSchema,
  MemoryFactQuerySchema,
  MemoryFactShownSchema,
  MemoryFactValueSchema,
  MemorySubjectSchema,
  MemoryWarningRuleSchema,
  TemplateMemorySchema,
} from './memory.js';
import { ActionExplanationSchema } from './trust.js';

const clientId = '0192f2c4-6a3b-7c1d-8e9f-0a1b2c3d4e5f';

describe('memory facts (ADR-0034)', () => {
  it('names a subject by type, with an id except for the business', () => {
    expect(MemorySubjectSchema.parse({ type: 'business' })).toEqual({ type: 'business' });
    expect(MemorySubjectSchema.parse({ type: 'client', id: clientId.toUpperCase() })).toEqual({
      type: 'client',
      id: clientId,
    });
    expect(MemorySubjectSchema.safeParse({ type: 'client' }).success).toBe(false);
    expect(MemorySubjectSchema.safeParse({ type: 'business', id: clientId }).success).toBe(false);
    expect(MemorySubjectSchema.safeParse({ type: 'tenant', id: clientId }).success).toBe(false);
  });

  it('keys are short lowercase names', () => {
    expect(MemoryFactKeySchema.parse(' Usual_Service ')).toBe('usual_service');
    for (const bad of ['', '1st', 'two words', 'a'.repeat(41), 'drop;table']) {
      expect(MemoryFactKeySchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('values are a sentence at most and never contact details', () => {
    expect(MemoryFactValueSchema.parse('  6N + 20 vol, 35 min ')).toBe('6N + 20 vol, 35 min');
    expect(MemoryFactValueSchema.safeParse('').success).toBe(false);
    expect(MemoryFactValueSchema.safeParse('x'.repeat(501)).success).toBe(false);
    expect(MemoryFactValueSchema.safeParse('Reach her at maria@example.com').success).toBe(false);
    expect(MemoryFactValueSchema.safeParse('Call 555-201-3344 first').success).toBe(false);
    // Dates and times are not phone numbers.
    expect(MemoryFactValueSchema.safeParse('Prefers 2026-11-02 at 10:30').success).toBe(true);
  });

  it('a fact to save: sensitivity optional, nothing extra', () => {
    const input = { subject: { type: 'client', id: clientId }, key: 'allergy', value: 'PPD' };
    expect(MemoryFactInputSchema.parse(input)).toEqual(input);
    expect(MemoryFactInputSchema.safeParse({ ...input, tenantId: clientId }).success).toBe(false);
    expect(MemoryFactOriginSchema.parse({ source: 'screen' })).toEqual({
      source: 'screen',
      turnId: null,
      status: 'active',
    });
  });

  it('a change names the value or the sensitivity', () => {
    expect(MemoryFactChangeSchema.safeParse({}).success).toBe(false);
    expect(MemoryFactChangeSchema.parse({ sensitive: true })).toEqual({ sensitive: true });
  });

  it('a query lists active facts by default, at most 500', () => {
    expect(MemoryFactQuerySchema.parse({})).toEqual({ status: 'active', limit: 200 });
    expect(MemoryFactQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});

describe('memory episodes', () => {
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.01);

  it('embeddings have exactly the stored size and finite numbers', () => {
    expect(EmbeddingSchema.safeParse(embedding).success).toBe(true);
    expect(EmbeddingSchema.safeParse(embedding.slice(1)).success).toBe(false);
    expect(EmbeddingSchema.safeParse([...embedding.slice(1), Number.NaN]).success).toBe(false);
  });

  it('an episode is a short summary with the clients it names', () => {
    const parsed = MemoryEpisodeInputSchema.parse({
      conversationId: null,
      summary: ' Jess keeps Saturdays free. ',
      embedding,
      embeddingModel: 'text-embedding-3-small',
    });
    expect(parsed.summary).toBe('Jess keeps Saturdays free.');
    expect(parsed.clientIds).toEqual([]);
    expect(
      MemoryEpisodeInputSchema.safeParse({ ...parsed, summary: 'x'.repeat(1001) }).success,
    ).toBe(false);
    expect(
      MemoryEpisodeInputSchema.safeParse({ ...parsed, clientIds: Array(21).fill(clientId) })
        .success,
    ).toBe(false);
    expect(
      MemoryEpisodeInputSchema.safeParse({ ...parsed, embeddingModel: 'Bad Model' }).success,
    ).toBe(false);
  });
});

describe('memory in the AI (S30)', () => {
  const factId = '0192f2c4-6a3b-7c1d-8e9f-0a1b2c3d4e60';

  it('a fact shown live is known with its value, or gone with its id only', () => {
    expect(
      MemoryFactShownSchema.parse({
        state: 'known',
        factId,
        subjectType: 'client',
        key: 'allergy',
        value: 'PPD',
        previous: null,
        sensitive: true,
      }),
    ).toMatchObject({ value: 'PPD' });
    expect(MemoryFactShownSchema.parse({ state: 'gone', factId })).toEqual({
      state: 'gone',
      factId,
    });
    expect(MemoryFactShownSchema.safeParse({ state: 'gone', factId, value: 'PPD' }).success).toBe(
      false,
    );
  });

  it('a template warns about keys by service category and suggests visit-note keys', () => {
    expect(TemplateMemorySchema.parse({})).toEqual({ warnings: [], visitNoteKeys: [] });
    expect(
      MemoryWarningRuleSchema.parse({ serviceCategories: ['Color'], keys: ['Allergy'] }),
    ).toEqual({ serviceCategories: ['Color'], keys: ['allergy'] });
    expect(
      MemoryWarningRuleSchema.safeParse({ serviceCategories: [], keys: ['allergy'] }).success,
    ).toBe(false);
  });

  it('an AI action names a remembered fact by its id, never by its value', () => {
    const why = (facts: unknown) =>
      ActionExplanationSchema.safeParse({
        requestMessageId: null,
        steps: [],
        facts,
        alternatives: [],
        untrustedContext: false,
        decision: { outcome: 'propose', reason: 'setting' },
      }).success;
    expect(why([{ kind: 'memory_warning', ref: factId, value: null }])).toBe(true);
    expect(why([{ kind: 'memory_warning', ref: factId, value: 'PPD' }])).toBe(false);
    expect(why([{ kind: 'memory_recalled', ref: null, value: null }])).toBe(false);
    expect(why([{ kind: 'slot_was_free', ref: null, value: { time: '10:00' } }])).toBe(true);
  });
});
