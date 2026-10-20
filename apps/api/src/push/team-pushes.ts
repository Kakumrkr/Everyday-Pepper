import { queueBookingPagePush, type BookingNotice } from '@pepper/appointments';
import { systemClock, type Clock } from '@pepper/core';
import type { TenantTx } from '@pepper/db';
import { Inject, Injectable } from '@nestjs/common';

export interface PushOptions {
  /** The public VAPID key; `null`: pushes are off and nothing is queued. */
  publicKey: string | null;
  /** Seals the pushes queued in the outbox (ADR-0024). */
  outboxKey: Buffer;
  clock?: Clock;
}

export const PUSH_OPTIONS = Symbol('PUSH_OPTIONS');

/**
 * The team's pushes about what happens on the booking page (ADR-0026), queued in the outbox
 * inside the change's transaction, next to the client's email. Off (queues nothing) without
 * a VAPID key, so a deployment without push never fills the outbox with pushes it cannot send.
 */
@Injectable()
export class TeamPushes {
  constructor(@Inject(PUSH_OPTIONS) private readonly options: PushOptions) {}

  get enabled(): boolean {
    return this.options.publicKey !== null;
  }

  async bookingPage(tx: TenantTx, notice: BookingNotice): Promise<void> {
    if (!this.enabled) return;
    await queueBookingPagePush(tx, notice, {
      key: this.options.outboxKey,
      now: (this.options.clock ?? systemClock).now(),
    });
  }
}
