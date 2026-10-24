import { UnsubscribeResponseSchema, type UnsubscribeResponse } from '@pepper/contracts';
import { describeUnsubscribe, unsubscribe, unsubscribeKeyFrom, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Req,
  type DynamicModule,
} from '@nestjs/common';
import { z } from 'zod';
import { SkipOriginCheck } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';

// One-click unsubscribe from rebooking emails (S36, ADR-0040; RFC 8058, CAN-SPAM): no session.
// The link's secret names the business and the client and is checked before anything is read.
// GET only describes (mail scanners open links); POST unsubscribes, from the page or from the
// mail provider itself (`List-Unsubscribe-Post`), which sends no `Origin`: the secret is the
// authority, and the only thing it can do is stop marketing email to that one client.

const LINK_USES: RateLimit = { name: 'unsubscribe-ip', max: 30, windowSeconds: 600 };
// A mail provider sends every recipient's one-click POST from a few shared addresses, and a
// refused one may never be retried (CAN-SPAM): its limit only stops a flood. The secret is
// checked before anything is read, so a wrong one costs an HMAC.
const ONE_CLICKS: RateLimit = { name: 'unsubscribe-post-ip', max: 600, windowSeconds: 600 };
const TokenParamsSchema = z.object({ token: z.string().max(400) });

export interface UnsubscribeOptions {
  /** The outbox key (`outboxKeyFrom(OUTBOX_SECRET)`); the links' key is derived from it. */
  outboxKey: Buffer;
  clock?: Clock;
}

export const UNSUBSCRIBE_OPTIONS = Symbol('UNSUBSCRIBE_OPTIONS');

type IncomingRequest = Parameters<typeof clientAddress>[0];

@Controller('v1/public/unsubscribe/:token')
export class UnsubscribeController {
  private readonly db: Database;
  private readonly key: Buffer;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(UNSUBSCRIBE_OPTIONS) private readonly options: UnsubscribeOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
    this.key = unsubscribeKeyFrom(options.outboxKey);
  }

  /** The business's name and whether the client is out; 404 `unsubscribe_link_invalid`. */
  @Get()
  async describe(
    @Param() params: unknown,
    @Req() request: IncomingRequest,
  ): Promise<UnsubscribeResponse> {
    const { token } = parseBody(TokenParamsSchema, params);
    await this.limits.hit(LINK_USES, clientAddress(request));
    return UnsubscribeResponseSchema.parse(
      await answering(() => describeUnsubscribe(this.db, this.key, token)),
    );
  }

  /** Unsubscribes (idempotent); 404 `unsubscribe_link_invalid`. */
  @Post()
  @HttpCode(200)
  @SkipOriginCheck()
  async unsubscribe(
    @Param() params: unknown,
    @Req() request: IncomingRequest,
  ): Promise<UnsubscribeResponse> {
    const { token } = parseBody(TokenParamsSchema, params);
    await this.limits.hit(ONE_CLICKS, clientAddress(request));
    return UnsubscribeResponseSchema.parse(
      await answering(() =>
        unsubscribe(this.db, this.key, token, {
          ...(this.options.clock !== undefined && { clock: this.options.clock }),
        }),
      ),
    );
  }
}

/** One-click unsubscribe. Needs `ConnectionsModule`. */
@Module({})
export class UnsubscribeModule {
  static forRoot(options: UnsubscribeOptions): DynamicModule {
    return {
      module: UnsubscribeModule,
      controllers: [UnsubscribeController],
      providers: [{ provide: UNSUBSCRIBE_OPTIONS, useValue: options }, RateLimiter],
    };
  }
}
