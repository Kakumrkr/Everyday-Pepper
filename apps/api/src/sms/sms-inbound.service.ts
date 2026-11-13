import { createHash } from 'node:crypto';
import { confirmBookingByText } from '@pepper/appointments';
import { approvalCodeOf, classifySmsReply } from '@pepper/contracts';
import {
  claimApprovalText,
  ForbiddenError,
  handleInboundSms,
  ProposalNotFoundError,
  ProposalNotPendingError,
  smsCodeKeyFrom,
  systemClock,
  type Clock,
} from '@pepper/core';
import { isSmsOptedOut, type Database, type SmsProvider } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Inject, Injectable } from '@nestjs/common';
import { AiActionsService } from '../chat/ai-actions.service.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';

// A text to Pepper's one number, whoever carried it (S61–S63, ADR-0065 §5, ADR-0066 §4): Twilio's
// signed webhook, or the sandbox's path in tests (AC-X-87). Keywords first (an opt-out always
// wins), then "C" to confirm a visit, then "Y" and a code to approve a card. The reply is
// answered in the same request. Neither a number nor a text is logged.

export interface SmsInboundOptions {
  /** The public origin (`AUTH_BASE_URL`), for the help link. */
  baseUrl: string;
  /** Seals the outbox; the codes' key derives from it. */
  outboxKey: Buffer;
  clock?: Clock;
}

export const SMS_INBOUND_OPTIONS = Symbol('SMS_INBOUND_OPTIONS');

/** A text as it reached Pepper. */
export interface InboundText {
  provider: SmsProvider;
  /** The provider's id for the message (a retry carries the same). */
  eventId: string;
  from: string;
  body: string;
}

// A number's wrong codes: after 5 in an hour its codes stop for the hour (AC-X-85).
const MISSES: RateLimit = { name: 'sms-approval-miss', max: 5, windowSeconds: 3600 };

/** The answers to "Y" (one for every miss, so a reply never says whether a code exists). */
export const APPROVAL_REPLIES = {
  miss: "Pepper: That code doesn't match a card waiting for you. Open Pepper to see what's waiting.",
  used: "Pepper: That one's already done.",
  expired: "Pepper: That card has expired. Open Pepper to see what's waiting.",
  done: 'Pepper: Done. You can undo it from Activity in Pepper.',
  changed: "Pepper: That card changed since my text, so I didn't do it. Open Pepper to see it now.",
  refused: "Pepper: I couldn't do that any more. Open Pepper to see why.",
  handled: 'Pepper: That card was already handled in Pepper.',
  withoutCode: 'Pepper: To approve a card, reply Y and the code from my text, e.g. Y 4821.',
} as const;

@Injectable()
export class SmsInboundService {
  private readonly db: Database;
  private readonly codeKey: Buffer;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(SMS_INBOUND_OPTIONS) private readonly options: SmsInboundOptions,
    private readonly limits: RateLimiter,
    private readonly approvals: AiActionsService,
  ) {
    this.db = database.db;
    this.codeKey = smsCodeKeyFrom(options.outboxKey);
  }

  /** Handles one text and answers its reply (`null`: none). */
  async handle(text: InboundText): Promise<string | null> {
    const receivedAt = (this.options.clock ?? systemClock).now();
    const result = await handleInboundSms(
      this.db,
      { ...text, receivedAt },
      { helpUrl: new URL('/help', this.options.baseUrl).toString() },
    );
    if (result.keyword !== null) return result.reply;
    switch (classifySmsReply(text.body)) {
      case 'confirm':
        return (await confirmBookingByText(this.db, { from: text.from, receivedAt })).reply;
      case 'approve':
        return this.approve(text.from, approvalCodeOf(text.body) ?? '', receivedAt);
      case 'approve_without_code':
        return (await this.optedOut(text.from)) ? null : APPROVAL_REPLIES.withoutCode;
      default:
        return result.reply;
    }
  }

  /**
   * "Y" and a code (AC-X-83…85): a number with 5 misses this hour gets the miss answer without a
   * lookup; the text is claimed (spent) first, then approved as its member with what it showed.
   * After a STOP nothing is answered.
   */
  private async approve(from: string, code: string, receivedAt: Date): Promise<string | null> {
    if (await this.optedOut(from)) return null;
    const counter = createHash('sha256').update(from).digest('hex');
    if (await this.limits.spent(MISSES, counter)) return APPROVAL_REPLIES.miss;
    const claim = await claimApprovalText(
      this.db,
      { from, code, receivedAt },
      { codeKey: this.codeKey },
    );
    switch (claim.kind) {
      case 'miss':
        await this.limits.hit(MISSES, counter).catch(() => undefined);
        return APPROVAL_REPLIES.miss;
      case 'used':
        return APPROVAL_REPLIES.used;
      case 'expired':
        return APPROVAL_REPLIES.expired;
      case 'claimed':
        break;
    }
    try {
      const result = await this.approvals.approve(
        claim.context,
        claim.proposalId,
        claim.fingerprint,
      );
      switch (result.kind) {
        case 'executed':
          return APPROVAL_REPLIES.done;
        case 'stale':
          return APPROVAL_REPLIES.changed;
        case 'refused':
          return APPROVAL_REPLIES.refused;
        case 'expired':
          return APPROVAL_REPLIES.expired;
      }
    } catch (error) {
      if (error instanceof ProposalNotPendingError) return APPROVAL_REPLIES.handled;
      if (error instanceof ForbiddenError || error instanceof ProposalNotFoundError) {
        return APPROVAL_REPLIES.miss;
      }
      throw error;
    }
  }

  private optedOut(from: string): Promise<boolean> {
    return isSmsOptedOut(this.db, from);
  }
}
