import { createHash } from 'node:crypto';
import {
  LlmResponseSchema,
  type LlmRequest,
  type LlmResponse,
  type LlmStreamEvent,
} from '@pepper/contracts';
import { z } from 'zod';
import type { LlmCallOptions, LlmProvider } from '../provider.js';

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

/** SHA-256 of the request with its keys sorted: equal requests, equal fingerprints. */
export function requestFingerprint(request: LlmRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(request)))
    .digest('hex');
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

  constructor(private readonly steps: readonly CassetteStep[]) {}

  respond(request: LlmRequest): Promise<LlmResponse> {
    const step = this.steps[this.next];
    this.next += 1;
    if (step === undefined) {
      return Promise.reject(
        new CassetteError('miss', `no recorded answer for call ${String(this.next)}`),
      );
    }
    if (step.fingerprint !== undefined && step.fingerprint !== requestFingerprint(request)) {
      return Promise.reject(
        new CassetteError('stale', `call ${String(this.next)} differs from the recorded request`),
      );
    }
    return Promise.resolve(step.response);
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
export function recordingProvider(provider: LlmProvider, steps: CassetteStep[]): LlmProvider {
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions) {
      const response = await provider.respond(request, options);
      steps.push({ fingerprint: requestFingerprint(request), response });
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions) {
      for await (const event of provider.stream(request, options)) {
        if (event.type === 'done') {
          steps.push({ fingerprint: requestFingerprint(request), response: event.response });
        }
        yield event;
      }
    },
  };
}
