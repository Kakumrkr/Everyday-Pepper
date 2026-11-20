import {
  normalizePhone,
  SMS_MEMBER_CONSENT_WORDING,
  smsConsentText,
  type MemberTexts,
} from '@pepper/contracts';
import { formatPhone } from './booking-profile';

// The words of "Cards to your phone" on Texts and reminders (S63.2, AC-X-88/89, ADR-0066): the
// member's own checked number and "Text me cards". The api decides who may and what is sent;
// these only say it.

export const MEMBER_TEXTS_PATH = '/v1/me/texts';
export const MEMBER_PHONE_PATH = '/v1/me/phone';
export const MEMBER_PHONE_VERIFY_PATH = '/v1/me/phone/verify';

/** The "Your number" row's value. */
export function numberLine(texts: MemberTexts): string {
  return texts.phone === null ? 'None yet' : formatPhone(texts.phone);
}

/** The button that opens the number sheet. */
export function numberAction(texts: MemberTexts): string {
  return texts.phone === null ? 'Add your number' : 'Change number';
}

/**
 * Under "Text me cards": with a checked number, the words the member agrees to by turning it on
 * (recorded with the consent, so shown exactly); without one, what to do first.
 */
export function cardTextsHint(texts: MemberTexts, business: string): string {
  if (texts.phone === null) {
    return 'Add your number first. Then I can text you cards that need your OK, like a waitlist offer, and you approve with a reply.';
  }
  return smsConsentText(SMS_MEMBER_CONSENT_WORDING, business);
}

/** A number as typed, as the code text will name it: `(555) 010-2233`, else as typed. */
export function typedNumber(value: string): string {
  return formatPhone(normalizePhone(value));
}

/** Whole minutes until `expiresAt`, at least 1. */
function minutesLeft(expiresAt: string, now: Date): number {
  return Math.max(1, Math.round((Date.parse(expiresAt) - now.getTime()) / 60_000));
}

/** The code step's line, once the text has gone. */
export function codeSentLine(typed: string, expiresAt: string, now: Date): string {
  const minutes = minutesLeft(expiresAt, now);
  const lasts = minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  return `I texted a code to ${typedNumber(typed)}. It works for ${lasts}.`;
}

/** Whether the code box holds six digits (the button waits until it does). */
export function isCodeShaped(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

/** The toast once a number is checked; a new number turns "Text me cards" off (ADR-0066 §1). */
export function checkedNote(before: MemberTexts, after: MemberTexts): string {
  if (before.cardTexts && !after.cardTexts) {
    return 'Number checked. Text me cards is off for the new number: turn it on again to get them.';
  }
  return after.cardTexts
    ? 'Number checked. Cards that need your OK come to it by text.'
    : 'Number checked. Turn on Text me cards to approve by text.';
}

/** The toast after "Text me cards" changes. */
export function cardTextsSavedNote(on: boolean): string {
  return on
    ? 'Saved. I’ll text you cards that need your OK.'
    : 'Saved. Cards stay in the app, no texts.';
}
