import { randomUUID } from 'node:crypto';
import {
  normalizePhone,
  SandboxInboundSmsRequestSchema,
  SandboxInboundSmsResponseSchema,
  SandboxSentSmsQuerySchema,
  SandboxSentSmsResponseSchema,
  type SandboxInboundSmsResponse,
  type SandboxSentSmsResponse,
} from '@pepper/contracts';
import { REDIS, SandboxTextLog, type Redis } from '@pepper/runtime';
import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { SkipOriginCheck } from '../auth/guards.js';
import { parseBody } from '../http/zod-body.js';
import { SmsInboundService } from './sms-inbound.service.js';

// The sandbox's text path (S63, ADR-0066 §5, AC-X-87): mounted only with `SMS_PROVIDER=sandbox`
// where tests run (CI, or a development machine), else these routes don't exist (404). A text
// "from" any number is handled exactly as Twilio's signed webhook handles one (keywords, "C",
// "Y" and a code), and what the worker's sandbox sent can be read back, so the journeys run
// end to end without a provider.

@Controller('v1/dev/sms')
export class SmsSandboxController {
  private readonly log: SandboxTextLog;

  constructor(
    private readonly inbound: SmsInboundService,
    @Inject(REDIS) redis: Redis,
  ) {
    this.log = new SandboxTextLog(redis);
  }

  /** 200 `{ reply }`: what Pepper answers the text; 400 `validation_failed`. */
  @Post('inbound')
  @HttpCode(200)
  @SkipOriginCheck()
  async receive(@Body() body: unknown): Promise<SandboxInboundSmsResponse> {
    const text = parseBody(SandboxInboundSmsRequestSchema, body);
    const reply = await this.inbound.handle({
      provider: 'sandbox',
      eventId: `SB${randomUUID().replace(/-/g, '')}`,
      from: normalizePhone(text.from),
      body: text.body,
    });
    return SandboxInboundSmsResponseSchema.parse({ reply });
  }

  /** 200 `{ texts }` sent to `to`, the newest first; 400 for a number Pepper can't text. */
  @Get('sent')
  async sent(@Query() query: unknown): Promise<SandboxSentSmsResponse> {
    const { to } = parseBody(SandboxSentSmsQuerySchema, query);
    return SandboxSentSmsResponseSchema.parse({ texts: await this.log.sentTo(to) });
  }
}
