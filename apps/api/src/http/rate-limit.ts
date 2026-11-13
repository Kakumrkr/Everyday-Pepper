import { REDIS, type Redis } from '@pepper/runtime';
import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';
import { TooManyRequestsException } from './domain-errors.js';

/** A limit: at most `max` hits per `windowSeconds`, counted per key. */
export interface RateLimit {
  /** Names the counter; with the key, it makes the Redis key. */
  name: string;
  max: number;
  windowSeconds: number;
}

/**
 * Fixed-window rate limits in Redis (ADR-0022), shared by every api instance. A hit over the
 * limit answers 429 `too_many_requests`. When Redis is unreachable the hit is refused with 503
 * `temporarily_unavailable` (fail closed): these limits guard anonymous endpoints that send
 * email.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Pick<Redis, 'multi' | 'get'>) {}

  /** Counts a hit of `key` against `limit`; throws 429 once it is over. */
  async hit(limit: RateLimit, key: string): Promise<void> {
    const redisKey = `pepper:rate:${limit.name}:${key}`;
    let count: number;
    try {
      const results = await this.redis
        .multi()
        .incr(redisKey)
        // NX: the window starts with the first hit and is not extended by later ones.
        .expire(redisKey, limit.windowSeconds, 'NX')
        .exec();
      const [incr] = results ?? [];
      if (incr?.[0] !== null) throw incr?.[0] ?? new Error('No reply');
      count = Number(incr[1]);
    } catch {
      throw new ServiceUnavailableException(apiError('temporarily_unavailable'));
    }
    if (count > limit.max) throw new TooManyRequestsException(apiError('too_many_requests'));
  }

  /** Whether `key` has used up `limit` in this window, without counting a hit (S63). */
  async spent(limit: RateLimit, key: string): Promise<boolean> {
    let value: string | null;
    try {
      value = await this.redis.get(`pepper:rate:${limit.name}:${key}`);
    } catch {
      throw new ServiceUnavailableException(apiError('temporarily_unavailable'));
    }
    return Number(value ?? 0) >= limit.max;
  }
}

/**
 * The client address to count a request against: the last `x-forwarded-for` entry, else the
 * socket's. The web app's server sets the header to the browser's address when the browser
 * sent none, and passes it on. A client that sends its own header chooses it until the edge
 * proxy of Phase 11 overwrites it, so limits that must hold also count per business.
 */
export function clientAddress(request: {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string | undefined };
}): string {
  const header = request.headers['x-forwarded-for'];
  const value = Array.isArray(header) ? header.join(',') : header;
  const last = value
    ?.split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .at(-1);
  return last ?? request.socket?.remoteAddress ?? 'unknown';
}
