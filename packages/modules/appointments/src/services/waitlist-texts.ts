import {
  ClientIdSchema,
  OutboxDedupeKeySchema,
  smsSendableAt,
  WAITLIST_OFFER_LIMITS,
  type OfferToken,
  type OutboxMessageId,
} from '@pepper/contracts';
import { queueSms } from '@pepper/core';
import type { Tenant, TenantTx, WaitlistOfferRow } from '@pepper/db';
import { offerUrl } from '../emails.js';
import { waitlistOfferText, waitlistOptInText } from '../texts.js';
import type { BookingEmailDetails } from './notices.js';
import { reminderSettingsOf, textableNumber } from './reminders.js';

// Waitlist offers by text (S79, ADR-0065 §S79): a freed time goes by text to a waitlist client
// whose consent in force names offers (`sms-consent-v3`), instead of the email; never to a
// regular (marketing texts need their own opt-in). Only while the deployment sends texts and
// the business's texts are on, and only when the text can go out, after the quiet hours, with
// time left to claim it.

/** The least an offer must still be open when its text can go out (the offer's own minimum). */
export const WAITLIST_TEXT_MIN_OPEN_MINUTES = WAITLIST_OFFER_LIMITS.minClaimMinutes;

const MINUTE_MS = 60_000;

export interface WaitlistTextOptions {
  /** Whether this deployment sends texts (`SMS_PROVIDER` set, ADR-0065); default no. */
  texts?: boolean | undefined;
}

/**
 * The number a waitlist offer closing at `closesAt` may be texted to, made at `now` (ms), or
 * `null`: texts off (the deployment's or the business's), no v3 consent the business may text
 * now, or the first minute it may go (`smsSendableAt`) leaves less than
 * `WAITLIST_TEXT_MIN_OPEN_MINUTES` (an offer at 23:00 that closes at 01:00).
 */
export async function offerTextNumber(
  tx: TenantTx,
  tenant: Pick<Tenant, 'timeZone' | 'reminderSettings'>,
  clientId: string,
  closes: { closesAt: number; now: number },
  options: WaitlistTextOptions,
): Promise<string | null> {
  if (options.texts !== true || !reminderSettingsOf(tenant).texts) return null;
  const sendAt = smsSendableAt(tenant.timeZone, closes.now);
  if (closes.closesAt - sendAt < WAITLIST_TEXT_MIN_OPEN_MINUTES * MINUTE_MS) return null;
  return textableNumber(tx, ClientIdSchema.parse(clientId), 'waitlist_offer');
}

/**
 * Texts a waitlist offer to its client (AC-X-224…227), once whatever the retries
 * (`waitlist.offer.sms:<offer id>`), dropped at delivery if still unsent when it closes; held
 * `holdSeconds` first (the AI's undo-send grace). Returns whether the offer goes by text (queued
 * now or already), so the caller sends no email, and the message just queued; `texted: false`
 * for a regular's offer or a client who can't be texted it.
 */
export async function queueWaitlistOfferText(
  tx: TenantTx,
  tenant: Pick<Tenant, 'timeZone' | 'reminderSettings' | 'slug'>,
  input: {
    offer: Pick<WaitlistOfferRow, 'id' | 'source' | 'clientId' | 'expiresAt'>;
    token: OfferToken;
    details: BookingEmailDetails;
  },
  options: WaitlistTextOptions & {
    baseUrl: string;
    outboxKey: Buffer;
    now: Date;
    holdSeconds?: number;
  },
): Promise<{ texted: boolean; messageId?: OutboxMessageId }> {
  const { offer } = input;
  if (offer.source !== 'waitlist') return { texted: false };
  const now = options.now.getTime() + (options.holdSeconds ?? 0) * 1000;
  const closesAt = offer.expiresAt.getTime();
  const phone = await offerTextNumber(tx, tenant, offer.clientId, { closesAt, now }, options);
  if (phone === null) return { texted: false };
  const expiresAt = offer.expiresAt.toISOString();
  const messageId = await queueSms(
    tx,
    {
      to: phone,
      body: waitlistOfferText(
        input.details,
        offerUrl(options.baseUrl, tenant.slug, input.token),
        expiresAt,
        smsSendableAt(tenant.timeZone, now),
      ),
      wordsBy: 'template',
      purpose: 'waitlist_offer',
      validUntil: expiresAt,
    },
    {
      key: options.outboxKey,
      dedupeKey: OutboxDedupeKeySchema.parse(`waitlist.offer.sms:${offer.id}`),
      now: new Date(now),
    },
  );
  return messageId === undefined ? { texted: true } : { texted: true, messageId };
}

/** What a waitlist opt-in text needs: the client's new consent and what they wait for. */
export interface WaitlistOptInNotice {
  phone: string;
  /** The entry it is about: one text per entry, whatever the retries. */
  entryId: string;
  details: Pick<BookingEmailDetails, 'businessName' | 'serviceName'>;
}

/** Queues a waitlist client's opt-in text in the open transaction (the api's, S79). */
export type WaitlistOptInNotify = (tx: TenantTx, notice: WaitlistOptInNotice) => Promise<void>;

/**
 * The first text after a waitlist client's yes (AC-X-223): who, what, how often, HELP and STOP.
 * Only while texts are on; checked again at delivery against the new consent. Returns the
 * message id, or `undefined` when no text goes (or it was queued already).
 */
export async function queueWaitlistOptInText(
  tx: TenantTx,
  tenant: Pick<Tenant, 'reminderSettings'>,
  notice: WaitlistOptInNotice,
  options: WaitlistTextOptions & { outboxKey: Buffer; now: Date },
): Promise<OutboxMessageId | undefined> {
  if (options.texts !== true || !reminderSettingsOf(tenant).texts) return undefined;
  return queueSms(
    tx,
    {
      to: notice.phone,
      body: waitlistOptInText(notice.details),
      wordsBy: 'template',
      purpose: 'waitlist_offer',
    },
    {
      key: options.outboxKey,
      dedupeKey: OutboxDedupeKeySchema.parse(`waitlist.opt_in.sms:${notice.entryId}`),
      now: options.now,
    },
  );
}
