import { createHash } from 'node:crypto';
import {
  LlmResponseSchema,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
} from '@pepper/contracts';
import { z } from 'zod';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import { fillPlaceholders, unfillPlaceholders } from './world.js';

/**
 * One answer in a cassette. A recorded answer carries the fingerprint of the request it
 * answered, so a changed prompt or tool cannot reuse it; a hand-written one has none.
 */
export const CassetteStepSchema = z.strictObject({
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  response: LlmResponseSchema,
});
export type CassetteStep = z.infer<typeof CassetteStepSchema>;

/** A case's cassette: one list of steps per trial (pass^k records k trials). */
export const CassetteSchema = z.strictObject({
  version: z.literal(1),
  trials: z.array(z.array(CassetteStepSchema)).min(1),
});
export type Cassette = z.infer<typeof CassetteSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

/**
 * SHA-256 of the request with its keys sorted: equal requests, equal fingerprints. The seeded
 * world's ids are put back as placeholders first and the ids the run created are numbered, so
 * the same case in a fresh world (new ids) makes the same request.
 */
export function requestFingerprint(
  request: LlmRequest,
  placeholders: ReadonlyMap<string, string> = new Map(),
): string {
  return createHash('sha256')
    .update(numberNewIds(unfillPlaceholders(JSON.stringify(canonical(request)), placeholders)))
    .digest('hex');
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Ids the run created (a new booking, a proposal) as `{{new:1}}`, `{{new:2}}` in order. */
function numberNewIds(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(UUID, (id) => {
    const key = id.toLowerCase();
    let placeholder = seen.get(key);
    if (placeholder === undefined) {
      placeholder = `{{new:${String(seen.size + 1)}}}`;
      seen.set(key, placeholder);
    }
    return placeholder;
  });
}

/** A recorded or hand-written answer with the world's ids filled in for its placeholders. */
function filled(response: LlmResponse, placeholders: ReadonlyMap<string, string>): LlmResponse {
  if (placeholders.size === 0) return response;
  return LlmResponseSchema.parse(
    JSON.parse(fillPlaceholders(JSON.stringify(response), placeholders)),
  );
}

/** A real answer with the world's ids put back as placeholders, to be recorded. */
function unfilled(response: LlmResponse, placeholders: ReadonlyMap<string, string>): LlmResponse {
  if (placeholders.size === 0) return response;
  return LlmResponseSchema.parse(
    JSON.parse(unfillPlaceholders(JSON.stringify(response), placeholders)),
  );
}

/** A cassette that has no answer for a call, or whose answer was for another request. */
export class CassetteError extends Error {
  override readonly name = 'CassetteError';
  constructor(
    readonly kind: 'miss' | 'stale',
    message: string,
  ) {
    super(message);
  }
}

/** Answers one trial's calls from its cassette steps, in order, at no cost. */
export class CassetteProvider implements LlmProvider {
  private next = 0;

  constructor(
    private readonly steps: readonly CassetteStep[],
    private readonly placeholders: ReadonlyMap<string, string> = new Map(),
  ) {}

  respond(request: LlmRequest): Promise<LlmResponse> {
    const step = this.steps[this.next];
    this.next += 1;
    if (step === undefined) {
      return Promise.reject(
        new CassetteError('miss', `no recorded answer for call ${String(this.next)}`),
      );
    }
    if (
      step.fingerprint !== undefined &&
      step.fingerprint !== requestFingerprint(request, this.placeholders)
    ) {
      return Promise.reject(
        new CassetteError('stale', `call ${String(this.next)} differs from the recorded request`),
      );
    }
    return Promise.resolve(filled(step.response, this.placeholders));
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamEvent> {
    const response = await this.respond(request);
    if (response.text !== '') yield { type: 'text_delta', delta: response.text };
    yield { type: 'done', response };
  }
}

/**
 * Wraps a real provider so each answer is also written down as a cassette step with its
 * request's fingerprint (S27 records the real model once; every later run replays for free).
 */
export function recordingProvider(
  provider: LlmProvider,
  steps: CassetteStep[],
  placeholders: ReadonlyMap<string, string> = new Map(),
): LlmProvider {
  const record = (request: LlmRequest, response: LlmResponse) => {
    steps.push({
      fingerprint: requestFingerprint(request, placeholders),
      response: unfilled(response, placeholders),
    });
  };
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions) {
      const response = await provider.respond(request, options);
      record(request, response);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions) {
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'done') record(request, event.response);
        yield event;
      }
    },
  };
}

/**
 * Records like `recordingProvider`, but first answers from an earlier recording of the same
 * trial while its requests are unchanged: only from the first new or changed request on does
 * the real provider get called (and paid). Every answer, replayed or new, lands in `steps`.
 */
export function replayOrRecordProvider(
  provider: LlmProvider,
  earlier: readonly CassetteStep[],
  steps: CassetteStep[],
  placeholders: ReadonlyMap<string, string> = new Map(),
): LlmProvider {
  const recorder = recordingProvider(provider, steps, placeholders);
  let replaying = true;
  const replayed = (request: LlmRequest): LlmResponse | null => {
    if (!replaying) return null;
    const step = earlier[steps.length];
    if (
      step?.fingerprint !== undefined &&
      step.fingerprint === requestFingerprint(request, placeholders)
    ) {
      steps.push(step);
      return filled(step.response, placeholders);
    }
    replaying = false;
    return null;
  };
  return {
    respond(request: LlmRequest, options?: LlmCallOptions) {
      const response = replayed(request);
      return response === null ? recorder.respond(request, options) : Promise.resolve(response);
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions) {
      const response = replayed(request);
      if (response === null) {
        yield* recorder.stream(request, options);
        return;
      }
      if (response.text !== '') yield { type: 'text_delta', delta: response.text };
      yield { type: 'done', response };
    },
  };
}
