import { createHmac } from 'node:crypto';
import { confirmBookingByText, keepClientText } from '@pepper/appointments';
import {
  approvalReplyOf,
  classifySmsReply,
  type ApprovalDecision,
  type TenantId,
} from '@pepper/contracts';
import {
  claimApprovalText,
  recordTextApproval,
  type ApprovalClaim,
  ForbiddenError,
  handleInboundSms,
  isTextedNumber,
  ProposalChangedError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  smsCodeKeyFrom,
  systemClock,
  type Clock,
} from '@pepper/core';
import { isMemberPhone, isSmsOptedOut, type Database, type SmsProvider } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AiActionsService } from '../chat/ai-actions.service.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';

// A text to Pepper's one number, whoever carried it (S61–S63, ADR-0065 §5, ADR-0066 §4): Twilio's
// signed webhook, or the sandbox's path in tests (AC-X-87). Keywords first (an opt-out always
// wins), then "C" to confirm a visit, then "Y" or "N" and a code to approve or skip a card
// (S64), then a client's own text, kept by the one business it fits or answered once a day with
// a reply that names no business (S80, ADR-0072). The reply is answered in the same request.
// Neither a number nor a text is logged.

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

// A number's own texts kept: at most 60 an hour (a looping phone or an auto-responder is cut off).
const KEPT_TEXTS: RateLimit = { name: 'sms-client-text', max: 60, windowSeconds: 3600 };

// A text no business fits gets the neutral reply once a day per number (S80, AC-X-230).
const NEUTRAL_REPLIES: RateLimit = { name: 'sms-neutral-reply', max: 1, windowSeconds: 86_400 };

/** The answer to a text no business fits, or two do (AC-X-230): it names no business. */
export const NEUTRAL_REPLY =
  "Pepper: We couldn't tell which business this text is for, so it wasn't passed on. Please contact the business directly. Reply STOP to opt out.";

// A number's wrong codes: after 5 in an hour its codes stop for the hour (AC-X-85).
const MISSES: RateLimit = { name: 'sms-approval-miss', max: 5, windowSeconds: 3600 };

/** The answers to "Y" and "N" (one for every miss, so a reply never says whether a code exists). */
export const APPROVAL_REPLIES = {
  miss: "Pepper: That code doesn't match a card waiting for you. Open Pepper to see what's waiting.",
  used: "Pepper: That one's already done.",
  expired: "Pepper: That card has expired. Open Pepper to see what's waiting.",
  done: 'Pepper: Done. You can undo it from Activity in Pepper.',
  changed: "Pepper: That card changed since my text, so I didn't do it. Open Pepper to see it now.",
  refused: "Pepper: I couldn't do that any more. Open Pepper to see why.",
  handled: 'Pepper: That card was already handled in Pepper.',
  skipped: 'Pepper: Skipped. Nothing was done.',
  changedNotSkipped:
    'Pepper: That card changed since my text, so I left it for you. Open Pepper to see it now.',
  withoutCode: 'Pepper: To approve a card, reply Y and the code from my text, e.g. Y 4821.',
  skipWithoutCode: 'Pepper: To skip a card, reply N and the code from my text, e.g. N 4821.',
} as const;

@Injectable()
export class SmsInboundService {
  private readonly db: Database;
  private readonly codeKey: Buffer;
  private readonly logger = new Logger(SmsInboundService.name);

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
    const kind = classifySmsReply(text.body);
    switch (kind) {
      case 'confirm':
        return (await confirmBookingByText(this.db, { from: text.from, receivedAt })).reply;
      case 'approve':
      case 'skip': {
        const reply = approvalReplyOf(text.body);
        if (reply === null) return null;
        return this.decide(text.from, reply.code, reply.decision, receivedAt);
      }
      case 'approve_without_code':
      case 'skip_without_code':
        // To a member's checked number, how to answer a card; a client's "Y" or "No" to a
        // reminder is their own text (S80).
        if (await isMemberPhone(this.db, text.from)) {
          return (await this.optedOut(text.from))
            ? null
            : APPROVAL_REPLIES[kind === 'skip_without_code' ? 'skipWithoutCode' : 'withoutCode'];
        }
        return this.keep(text, receivedAt);
      // The keywords were answered above.
      case 'help':
      case 'start':
      case 'stop':
        return result.reply;
      case null:
        return this.keep(text, receivedAt);
    }
  }

  /**
   * A client's own text (S80, AC-X-229, AC-X-230): kept by the one business it fits, unanswered
   * (a member replies from its card); else stored nowhere, with the neutral reply once a day to a
   * number some business texts, never after a STOP, never to a member's number.
   */
  private async keep(text: InboundText, receivedAt: Date): Promise<string | null> {
    const counter = (name: string) =>
      createHmac('sha256', this.codeKey).update(`${name}\n${text.from}`).digest('hex');
    // Past the hour's limit a text is dropped, unanswered; without Redis it is still kept.
    const flood = await this.limits.spent(KEPT_TEXTS, counter('client-text')).catch(() => false);
    if (flood) return null;
    await this.limits.hit(KEPT_TEXTS, counter('client-text')).catch(() => undefined);
    const kept = await keepClientText(this.db, { ...text, receivedAt });
    if (kept.outcome === 'kept') return null;
    if (await this.optedOut(text.from)) return null;
    if (await isMemberPhone(this.db, text.from)) return null;
    if (!(await isTextedNumber(this.db, text.from))) return null;
    const neutral = counter('neutral-reply');
    try {
      if (await this.limits.spent(NEUTRAL_REPLIES, neutral)) return null;
      await this.limits.hit(NEUTRAL_REPLIES, neutral);
    } catch {
      // Redis is away: no reply rather than one that may repeat (the text is stored nowhere).
      return null;
    }
    return NEUTRAL_REPLY;
  }

  /**
   * "Y" or "N" and a code (AC-X-83…85, AC-X-93…94): a number with 5 misses this hour (of either)
   * gets the miss answer without a lookup; the text is claimed (spent) first, then approved or
   * skipped as its member with what it showed. After a STOP nothing is answered.
   */
  private async decide(
    from: string,
    code: string,
    decision: ApprovalDecision,
    receivedAt: Date,
  ): Promise<string | null> {
    if (await this.optedOut(from)) return null;
    // Keyed by an HMAC, so the counters in Redis never reveal a number.
    const counter = createHmac('sha256', this.codeKey)
      .update(`approval-miss\n${from}`)
      .digest('hex');
    if (await this.limits.spent(MISSES, counter)) return APPROVAL_REPLIES.miss;
    const claim = await claimApprovalText(
      this.db,
      { from, code, receivedAt, decision },
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
    if (decision === 'skip') return this.skip(claim);
    try {
      const result = await this.approvals.approve(
        claim.context,
        claim.proposalId,
        claim.fingerprint,
        { firstOnly: true },
      );
      switch (result.kind) {
        case 'executed':
          await this.linkExecution(claim.tenantId, claim.approvalTextId, result.action.id);
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
      // The code is spent: a 500 would have Twilio retry it into "already done". Say it didn't,
      // and report the failure (its kind only: never the number or the text).
      this.logger.error(
        `An approval by text failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return APPROVAL_REPLIES.refused;
    }
  }

  /** "N" and a code, claimed: the card is declined as its member, as in the app (AC-X-93). */
  private async skip(claim: Extract<ApprovalClaim, { kind: 'claimed' }>): Promise<string> {
    try {
      await this.approvals.skip(claim.context, claim.proposalId, claim.fingerprint);
      return APPROVAL_REPLIES.skipped;
    } catch (error) {
      if (error instanceof ProposalChangedError) return APPROVAL_REPLIES.changedNotSkipped;
      if (error instanceof ProposalNotPendingError) {
        return error.status === 'expired' ? APPROVAL_REPLIES.expired : APPROVAL_REPLIES.handled;
      }
      if (error instanceof ForbiddenError || error instanceof ProposalNotFoundError) {
        return APPROVAL_REPLIES.miss;
      }
      this.logger.error(
        `A skip by text failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return APPROVAL_REPLIES.refused;
    }
  }

  /**
   * Activity's "approved by text" (S63.2, AC-X-91). The card is done either way, so a failure
   * here only loses that label: it is reported, never answered as a failed approval.
   */
  private async linkExecution(
    tenantId: TenantId,
    approvalTextId: string,
    executionId: string,
  ): Promise<void> {
    try {
      await recordTextApproval(this.db, tenantId, approvalTextId, executionId);
    } catch (error) {
      this.logger.error(
        `Linking an approval by text failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  }

  private optedOut(from: string): Promise<boolean> {
    return isSmsOptedOut(this.db, from);
  }
}
