import { randomBytes } from 'node:crypto';
import { OUTBOX_MAX_ATTEMPTS, OutboxMessageIdSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  errorNameOf,
  failureOutcome,
  openOutboxContent,
  outboxKeyFrom,
  OutboxContentError,
  sealOutboxContent,
} from './outbox.js';

const ID = OutboxMessageIdSchema.parse('0199f4b2-7c1e-7a00-8000-000000000001');
const OTHER = OutboxMessageIdSchema.parse('0199f4b2-7c1e-7a00-8000-000000000002');
const key = outboxKeyFrom('a-local-test-outbox-secret-of-32-chars');
const content = Buffer.from('{"to":"ana@example.com"}');

describe('outboxKeyFrom', () => {
  it('derives a stable 32-byte key per secret', () => {
    expect(key).toHaveLength(32);
    expect(outboxKeyFrom('a-local-test-outbox-secret-of-32-chars').equals(key)).toBe(true);
    expect(outboxKeyFrom('a-local-test-outbox-secret-of-32-charsX').equals(key)).toBe(false);
  });

  it('refuses a short secret', () => {
    expect(() => outboxKeyFrom('short')).toThrow(RangeError);
  });
});

describe('sealing outbox content', () => {
  it('round-trips, with a fresh IV each time and no plaintext in the sealed form', () => {
    const sealed = sealOutboxContent(key, ID, content);
    expect(openOutboxContent(key, ID, sealed).equals(content)).toBe(true);
    expect(sealed.includes(Buffer.from('ana@example.com'))).toBe(false);
    expect(sealOutboxContent(key, ID, content).equals(sealed)).toBe(false);
    expect(sealed[0]).toBe(1);
  });

  it('does not open for another message, another key, or changed bytes', () => {
    const sealed = sealOutboxContent(key, ID, content);
    expect(() => openOutboxContent(key, OTHER, sealed)).toThrow(OutboxContentError);
    expect(() => openOutboxContent(randomBytes(32), ID, sealed)).toThrow(OutboxContentError);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
    expect(() => openOutboxContent(key, ID, tampered)).toThrow(OutboxContentError);
  });

  it('rejects a short buffer or an unknown version', () => {
    expect(() => openOutboxContent(key, ID, Buffer.alloc(10))).toThrow(OutboxContentError);
    const sealed = sealOutboxContent(key, ID, content);
    sealed[0] = 2;
    expect(() => openOutboxContent(key, ID, sealed)).toThrow(OutboxContentError);
  });

  it('needs a 32-byte key', () => {
    expect(() => sealOutboxContent(Buffer.alloc(16), ID, content)).toThrow(RangeError);
  });
});

describe('failureOutcome', () => {
  const now = new Date('2026-10-20T15:00:00Z');

  it('retries a passing failure with backoff', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNECTION' });
    expect(failureOutcome(error, 1, now)).toEqual({
      kind: 'retry',
      retryAt: new Date('2026-10-20T15:00:30Z'),
      errorName: 'ECONNECTION',
    });
    expect(failureOutcome(error, 3, now)).toMatchObject({
      retryAt: new Date('2026-10-20T15:02:00Z'),
    });
  });

  it('retries a 4xx answer (try again later)', () => {
    const error = Object.assign(new Error('451 busy'), { code: 'EMESSAGE', responseCode: 451 });
    expect(failureOutcome(error, 1, now).kind).toBe('retry');
  });

  it('gives up after the last attempt', () => {
    expect(failureOutcome(new Error('x'), OUTBOX_MAX_ATTEMPTS, now)).toEqual({
      kind: 'dead',
      errorName: 'Error',
    });
  });

  it('gives up at once on a 5xx answer or content that does not open', () => {
    const rejected = Object.assign(new Error('550 no such user ana@example.com'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
    expect(failureOutcome(rejected, 1, now)).toEqual({ kind: 'dead', errorName: 'EENVELOPE' });
    expect(failureOutcome(new OutboxContentError(), 1, now)).toEqual({
      kind: 'dead',
      errorName: 'OutboxContentError',
    });
  });

  it('names errors without their messages', () => {
    expect(errorNameOf(new TypeError('ana@example.com'))).toBe('TypeError');
    expect(errorNameOf(Object.assign(new Error('x'), { code: '' }))).toBe('Error');
    expect(errorNameOf('a string')).toBe('UnknownError');
    expect(failureOutcome('a string', 1, now).kind).toBe('retry');
  });
});
