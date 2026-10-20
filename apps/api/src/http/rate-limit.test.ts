import { type HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { clientAddress, RateLimiter, type RateLimit } from './rate-limit.js';

const LIMIT: RateLimit = { name: 'test', max: 2, windowSeconds: 60 };

/** A Redis stand-in: counts INCRs per key, remembers the EXPIRE arguments. */
function fakeRedis(options: { fail?: boolean } = {}) {
  const counts = new Map<string, number>();
  const expires: unknown[][] = [];
  const redis = {
    multi() {
      const steps: (() => [Error | null, unknown])[] = [];
      const chain = {
        incr(key: string) {
          steps.push(() => {
            const next = (counts.get(key) ?? 0) + 1;
            counts.set(key, next);
            return [null, next];
          });
          return chain;
        },
        expire(...args: unknown[]) {
          expires.push(args);
          steps.push(() => [null, 1]);
          return chain;
        },
        exec: vi.fn(() =>
          options.fail === true
            ? Promise.reject(new Error('Connection is closed'))
            : Promise.resolve(steps.map((step) => step())),
        ),
      };
      return chain;
    },
  };
  return { redis, counts, expires };
}

async function status(promise: Promise<unknown>): Promise<number | 'ok'> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    return (error as HttpException).getStatus();
  }
}

describe('RateLimiter', () => {
  it('allows `max` hits per key and window, then answers 429', async () => {
    const { redis, counts, expires } = fakeRedis();
    const limiter = new RateLimiter(redis as never);
    expect(await status(limiter.hit(LIMIT, '1.2.3.4'))).toBe('ok');
    expect(await status(limiter.hit(LIMIT, '1.2.3.4'))).toBe('ok');
    expect(await status(limiter.hit(LIMIT, '1.2.3.4'))).toBe(429);
    expect(await status(limiter.hit(LIMIT, '5.6.7.8'))).toBe('ok');
    expect([...counts.keys()]).toEqual(['pepper:rate:test:1.2.3.4', 'pepper:rate:test:5.6.7.8']);
    expect(expires[0]).toEqual(['pepper:rate:test:1.2.3.4', 60, 'NX']);
  });

  it('fails closed with 503 when Redis does not answer', async () => {
    const limiter = new RateLimiter(fakeRedis({ fail: true }).redis as never);
    expect(await status(limiter.hit(LIMIT, '1.2.3.4'))).toBe(503);
  });

  it('fails closed when a command errors', async () => {
    const redis = {
      multi: () => ({
        incr() {
          return this;
        },
        expire() {
          return this;
        },
        exec: () => Promise.resolve([[new Error('WRONGTYPE'), null]]),
      }),
    };
    expect(await status(new RateLimiter(redis as never).hit(LIMIT, 'x'))).toBe(503);
  });
});

describe('clientAddress', () => {
  it('takes the last x-forwarded-for entry', () => {
    expect(clientAddress({ headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' } })).toBe('1.2.3.4');
    expect(clientAddress({ headers: { 'x-forwarded-for': ['9.9.9.9', '1.2.3.4 '] } })).toBe(
      '1.2.3.4',
    );
  });

  it('falls back to the socket address, then a shared bucket', () => {
    expect(clientAddress({ headers: {}, socket: { remoteAddress: '::1' } })).toBe('::1');
    expect(clientAddress({ headers: { 'x-forwarded-for': ' , ' } })).toBe('unknown');
  });
});
