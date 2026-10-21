import { ChatEventEnvelopeSchema, type ChatEvent, type ChatEventEnvelope } from '@pepper/contracts';
import { REDIS, type Redis } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';

/** How long a turn's events stay readable for resuming (ADR-0030). */
export const TURN_EVENTS_TTL_SECONDS = 3_600;
const CANCEL_TTL_SECONDS = 120;

/**
 * Each turn's events in a Redis stream, so any api instance can stream or resume them
 * (`Last-Event-ID`): entry ids are `<seq>-0`, so reading after an event is a range read. Events
 * hold what the member sees (summaries, cards, the AI's words), never a client's contact.
 * Also carries a member's request to stop a turn to whichever instance runs it.
 */
@Injectable()
export class TurnEventLog {
  constructor(
    @Inject(REDIS)
    private readonly redis: Pick<Redis, 'multi' | 'xrange' | 'set' | 'exists' | 'del'>,
  ) {}

  async append(turnId: string, seq: number, event: ChatEvent): Promise<void> {
    const key = streamKey(turnId);
    await this.redis
      .multi()
      .xadd(key, `${String(seq)}-0`, 'event', JSON.stringify(event))
      .expire(key, TURN_EVENTS_TTL_SECONDS)
      .exec();
  }

  /** The turn's events after `afterSeq`, in order; `null` when none were ever kept (or expired). */
  async read(turnId: string, afterSeq: number): Promise<ChatEventEnvelope[] | null> {
    const entries = await this.redis.xrange(streamKey(turnId), `${String(afterSeq + 1)}-0`, '+');
    if (entries.length === 0 && afterSeq === 0) {
      return (await this.redis.exists(streamKey(turnId))) === 1 ? [] : null;
    }
    return entries.map(([id, fields]) =>
      ChatEventEnvelopeSchema.parse({
        seq: Number(id.split('-')[0]),
        event: JSON.parse(fields[1] ?? 'null') as unknown,
      }),
    );
  }

  /** Forgets a turn's events (tests: as when its log expired). */
  async drop(turnId: string): Promise<void> {
    await this.redis.del(streamKey(turnId));
  }

  async requestCancel(turnId: string): Promise<void> {
    await this.redis.set(cancelKey(turnId), '1', 'EX', CANCEL_TTL_SECONDS);
  }

  async cancelRequested(turnId: string): Promise<boolean> {
    return (await this.redis.exists(cancelKey(turnId))) === 1;
  }
}

const streamKey = (turnId: string) => `pepper:chat:turn:${turnId}`;
const cancelKey = (turnId: string) => `pepper:chat:cancel:${turnId}`;
