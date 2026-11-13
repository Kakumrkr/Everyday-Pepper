import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import {
  MemberTextsSchema,
  normalizePhone,
  PhoneCheckCodeSchema,
  SMS_MEMBER_CONSENT_WORDING,
  SmsPhoneSchema,
  TenantIdSchema,
  type MemberTexts,
} from '@pepper/contracts';
import {
  countUserPhoneCheckMiss,
  findActiveMemberSmsConsent,
  findMembership,
  findUserPhone,
  isSmsOptedOut,
  listUserBusinesses,
  lockUserPhone,
  newId,
  setMembershipCardTexts,
  setVerifiedUserPhone,
  startUserPhoneCheck,
  withMember,
  withTenant,
  withUser,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import { ForbiddenError, PhoneCheckError, PhoneNotCheckedError } from '../errors.js';
import { queueSms, recordSmsConsent, revokeSmsConsentFor } from './sms.js';

// A member's own number and "Text me cards" (S63, ADR-0066 §1–2). The number belongs to the
// account; a texted code proves it. The switch is per business, owners and managers only, and
// is the member's consent for that business's cards to that number.

/** How long a code works, and how many tries it has (AC-X-80). */
export const PHONE_CHECK_TTL_MS = 10 * 60 * 1000;
export const PHONE_CHECK_MAX_TRIES = 5;

/** The codes' key (phone checks and approval texts), from the outbox key. */
export function smsCodeKeyFrom(outboxKey: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', outboxKey, '', 'pepper/sms-codes', 32));
}

/**
 * The stored form of a texted code: HMAC-SHA256 under the deployment's key, bound to the number
 * and the code's purpose, so a leaked table without the key reveals none and a phone check's
 * code never answers an approval text.
 */
export function smsCodeHash(
  key: Buffer,
  purpose: 'phone_check' | 'approval',
  phone: string,
  code: string,
): string {
  if (key.length < 32) throw new RangeError('The code key needs at least 32 bytes');
  return createHmac('sha256', key)
    .update(`${purpose}\n${SmsPhoneSchema.parse(phone)}\n${code}`)
    .digest('hex');
}

/** Whether two hashes are the same, in constant time. */
export function sameCodeHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

const mayTextCards = (actor: Actor) =>
  actor.context.role === 'owner' || actor.context.role === 'manager';

export interface MemberTextsOptions {
  /** `smsCodeKeyFrom(outboxKey)`. */
  codeKey: Buffer;
  /** The outbox key the code's text is sealed with. */
  outboxKey: Buffer;
  clock?: Clock;
  /** Draws a code (tests pass a fixed one). */
  drawCode?: () => string;
}

/** The member's own texts in the session's business. */
export async function getMemberTexts(db: Database, actor: Actor): Promise<MemberTexts> {
  return withMember(db, actor.context, (tx) => memberTextsIn(tx, actor));
}

async function memberTextsIn(tx: TenantTx, actor: Actor): Promise<MemberTexts> {
  const phone = (await findUserPhone(tx, actor.context.userId))?.phone ?? null;
  const membership = await findMembership(tx, actor.context.userId);
  const consent =
    phone === null ? undefined : await findActiveMemberSmsConsent(tx, phone, actor.context.userId);
  return MemberTextsSchema.parse({
    phone,
    // On only with the member's own consent in force for the number they have now.
    cardTexts: membership?.cardTexts === true && consent !== undefined,
    canTextCards: mayTextCards(actor),
  });
}

/**
 * Texts a 6-digit code to the number the member typed (AC-X-80), replacing any check in flight:
 * the one text they asked for (`requested`: no standing consent; a STOP still drops it), urgent,
 * from the session's business's outbox. Refuses a number Pepper can't text, or one that replied
 * STOP. Returns until when the code works. The api limits how often (5 an hour).
 */
export async function startMemberPhoneCheck(
  db: Database,
  actor: Actor,
  typed: string,
  options: MemberTextsOptions,
): Promise<{ expiresAt: Date }> {
  if (actor.via === 'ai') throw new ForbiddenError();
  const phone = SmsPhoneSchema.safeParse(normalizePhone(typed));
  if (!phone.success) throw new PhoneCheckError('not_textable');
  const now = (options.clock ?? systemClock).now();
  const code = PhoneCheckCodeSchema.parse((options.drawCode ?? drawSixDigits)());
  const expiresAt = new Date(now.getTime() + PHONE_CHECK_TTL_MS);
  return withMember(db, actor.context, async (tx) => {
    if (await isSmsOptedOut(tx, phone.data)) throw new PhoneCheckError('opted_out');
    await startUserPhoneCheck(tx, {
      userId: actor.context.userId,
      phone: phone.data,
      codeHash: smsCodeHash(options.codeKey, 'phone_check', phone.data, code),
      expiresAt,
    });
    await queueSms(
      tx,
      {
        to: phone.data,
        body: `Pepper: your code is ${code}. It works for 10 minutes. Didn't ask for it? Ignore this text.`,
        urgent: true,
        requested: true,
        wordsBy: 'template',
      },
      { key: options.outboxKey, dedupeKey: `phone.check:${newId()}`, now },
    );
    return { expiresAt };
  });
}

/**
 * Checks the code (AC-X-80): right and in time, the number becomes the account's. A new number
 * ends "Text me cards" in every business the member is in (the old number's consents are
 * revoked; the switch is turned on again for the new one). A wrong code uses a try.
 */
export async function verifyMemberPhone(
  db: Database,
  actor: Actor,
  typedCode: string,
  options: MemberTextsOptions,
): Promise<MemberTexts> {
  if (actor.via === 'ai') throw new ForbiddenError();
  const code = PhoneCheckCodeSchema.safeParse(typedCode);
  const now = (options.clock ?? systemClock).now();
  const userId = actor.context.userId;
  const checked = await db.transaction(async (tx) => {
    const row = await lockUserPhone(tx, userId);
    if (
      row === undefined ||
      row.checkPhone === null ||
      row.checkHash === null ||
      row.checkExpiresAt === null ||
      row.checkExpiresAt.getTime() <= now.getTime()
    ) {
      return { error: 'no_check' as const };
    }
    if (row.checkAttempts >= PHONE_CHECK_MAX_TRIES) return { error: 'too_many_tries' as const };
    if (
      !code.success ||
      !sameCodeHash(
        row.checkHash,
        smsCodeHash(options.codeKey, 'phone_check', row.checkPhone, code.data),
      )
    ) {
      await countUserPhoneCheckMiss(tx, userId);
      return { error: 'wrong_code' as const };
    }
    await setVerifiedUserPhone(tx, userId, row.checkPhone, now);
    return { phone: row.checkPhone, previous: row.phone };
  });
  if ('error' in checked) throw new PhoneCheckError(checked.error);
  if (checked.previous !== null && checked.previous !== checked.phone) {
    const previous = checked.previous;
    const businesses = await withUser(db, userId, (tx) => listUserBusinesses(tx));
    for (const business of businesses) {
      await withTenant(db, TenantIdSchema.parse(business.tenantId), async (tx) => {
        await stopCardTextsIn(tx, actor, previous, now);
      });
    }
  }
  return getMemberTexts(db, actor);
}

/**
 * Turns "Text me cards" on or off in the session's business (AC-X-81): owners and managers,
 * with a checked number. On records their consent (`member_settings`, the words as shown), next
 * to any client consent for the number; off revokes it.
 */
export async function setMemberCardTexts(
  db: Database,
  actor: Actor,
  on: boolean,
  options: { clock?: Clock } = {},
): Promise<MemberTexts> {
  if (actor.via === 'ai' || !mayTextCards(actor)) throw new ForbiddenError();
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    const phone = (await findUserPhone(tx, actor.context.userId))?.phone ?? null;
    if (phone === null) {
      if (on) throw new PhoneNotCheckedError();
      await setMembershipCardTexts(tx, actor.context.userId, false);
      return memberTextsIn(tx, actor);
    }
    if (!on) {
      await stopCardTextsIn(tx, actor, phone, now);
      return memberTextsIn(tx, actor);
    }
    await setMembershipCardTexts(tx, actor.context.userId, true);
    const current = await memberTextsIn(tx, actor);
    if (!current.cardTexts) {
      await recordSmsConsent(
        tx,
        {
          phone,
          source: 'member_settings',
          userId: actor.context.userId,
          wordingVersion: SMS_MEMBER_CONSENT_WORDING,
          givenAt: now,
        },
        { actor: auditActorOf(actor), requestId: actor.requestId },
      );
    }
    return memberTextsIn(tx, actor);
  });
}

/** The switch off and the member's own consent for `phone` revoked, in this business. */
async function stopCardTextsIn(
  tx: TenantTx,
  actor: Actor,
  phone: string,
  now: Date,
): Promise<void> {
  await setMembershipCardTexts(tx, actor.context.userId, false);
  // Only the member's own: a client's consent for the same number stays.
  if ((await findActiveMemberSmsConsent(tx, phone, actor.context.userId)) !== undefined) {
    await revokeSmsConsentFor(tx, phone, 'member_settings', {
      actor: auditActorOf(actor),
      requestId: actor.requestId,
      now,
    });
  }
}

function drawSixDigits(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
