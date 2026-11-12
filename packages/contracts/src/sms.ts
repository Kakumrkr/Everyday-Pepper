import { z } from 'zod';
import { fromZoned, toZoned } from './zoned-time.js';

// The SMS channel (S61, ADR-0065): the rules every text follows, whoever sends it. A text goes
// out through the outbox (`OutboxSmsSchema`), only to a number with the business's consent and
// without a STOP, inside the quiet hours unless urgent; its words are kept in GSM-7 where a
// plain character means the same, and counted in segments, because each segment is paid for.

/**
 * A number Pepper can text: a US or Canadian number (NANP) in E.164 form, `+1` and ten digits
 * whose area code doesn't start with 0 or 1 (Twilio refuses the rest for good, AC-X-57). Other
 * countries come after V1.
 */
export const SmsPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+1[2-9]\d{9}$/, 'Use a US or Canadian number, e.g. +15551234567');
export type SmsPhone = z.infer<typeof SmsPhoneSchema>;

// GSM 03.38: the basic set (one septet each) and its extension (an escape and a septet, so two).
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM7_EXTENSION = new Set('^{}\\[~]|€\f');

/** A regular expression matching any one of the characters with these code points. */
function anyOf(...codePoints: number[]): RegExp {
  return new RegExp(codePoints.map((code) => String.fromCodePoint(code)).join('|'), 'g');
}

/**
 * Characters that look the same as a GSM-7 one (S61 top-up, AC-X-63): typed by phones and word
 * processors, or written by the AI. Left alone, one of them makes the whole text UCS-2, which
 * fits 70 characters a segment instead of 160.
 */
const PLAIN_FORMS: readonly [RegExp, string][] = [
  // Curly and prime single quotes, the grave and acute accents alone.
  [anyOf(0x2018, 0x2019, 0x201a, 0x201b, 0x2032, 0x60, 0xb4), "'"],
  // Curly and prime double quotes.
  [anyOf(0x201c, 0x201d, 0x201e, 0x201f, 0x2033), '"'],
  // Hyphens, dashes and the minus sign.
  [anyOf(0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212), '-'],
  // The ellipsis.
  [anyOf(0x2026), '...'],
  // No-break, figure, thin and other wide spaces.
  [anyOf(0xa0, 0x2002, 0x2003, 0x2007, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000), ' '],
  // Zero-width characters and the byte-order mark.
  [anyOf(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff), ''],
  // The bullet.
  [anyOf(0x2022), '-'],
  [/\r\n?/g, '\n'],
];

/** The text with look-alike characters in their plain GSM-7 form, trimmed. */
export function normalizeSmsText(text: string): string {
  let plain = text;
  for (const [pattern, replacement] of PLAIN_FORMS) plain = plain.replace(pattern, replacement);
  return plain.trim();
}

export interface SmsSegments {
  encoding: 'gsm7' | 'ucs2';
  /** Septets (GSM-7, an extension character counts two) or UTF-16 code units (UCS-2). */
  units: number;
  segments: number;
}

/**
 * How a text is encoded and how many segments it takes, as carriers bill it: 160 GSM-7 septets
 * alone, 153 a part when split; 70 UTF-16 units alone, 67 a part. A character is never split
 * between parts (an extension character's two septets, an emoji's two units), so a part may hold
 * one fewer.
 */
export function smsSegments(text: string): SmsSegments {
  // Code points, as carriers count them (not graphemes: a carrier may split a ZWJ emoji).
  const chars = Array.from(text);
  const septets: number[] = [];
  for (const char of chars) {
    if (GSM7_BASIC.has(char)) septets.push(1);
    else if (GSM7_EXTENSION.has(char)) septets.push(2);
    else break;
  }
  if (septets.length === chars.length) return packed('gsm7', septets, 160, 153);
  return packed(
    'ucs2',
    chars.map((char) => char.length),
    70,
    67,
  );
}

function packed(
  encoding: SmsSegments['encoding'],
  costs: readonly number[],
  alone: number,
  part: number,
): SmsSegments {
  const units = costs.reduce((sum, cost) => sum + cost, 0);
  if (units <= alone) return { encoding, units, segments: 1 };
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > part) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }
  return { encoding, units, segments };
}

/** The most segments one text may take: a reminder with its link fits in two. */
export const SMS_MAX_SEGMENTS = 3;

/** A text's words: normalised to GSM-7 where they can be, at most `SMS_MAX_SEGMENTS`. */
export const SmsBodySchema = z
  .string()
  .max(1000)
  .transform(normalizeSmsText)
  .pipe(
    z
      .string()
      .min(1)
      .refine((text) => smsSegments(text).segments <= SMS_MAX_SEGMENTS, {
        message: `Keep a text to ${String(SMS_MAX_SEGMENTS)} segments`,
      }),
  );

/**
 * One text, as queued (ADR-0065 §2). Its content is sealed like an email's and cleared once
 * sent. `urgent`: about today's appointment (running late), so the quiet hours don't hold it;
 * set by domain code only, never from a model's arguments.
 */
export const OutboxSmsSchema = z
  .object({
    to: SmsPhoneSchema,
    body: SmsBodySchema,
    urgent: z.literal(true).optional(),
  })
  .strict();
export type OutboxSms = z.infer<typeof OutboxSmsSchema>;
export type OutboxSmsInput = z.input<typeof OutboxSmsSchema>;

/**
 * When texts may go out, in the business's time zone (ADR-0065 §3): from 8:00 to before 20:00.
 * Florida's limit, the strictest in common use; the federal TCPA allows until 21:00.
 */
export const SMS_QUIET_HOURS = { startHour: 8, endHour: 20 } as const;

/** What a reply to Pepper's number asks for (AC-X-59). */
export type SmsKeyword = 'stop' | 'start' | 'help';
export const SmsKeywordSchema = z.enum(['stop', 'start', 'help']);

// The carriers' and Twilio's keywords, and the FCC's 2025 additions (OPTOUT, REVOKE).
const STOP_WORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'optout',
  'opt out',
  'revoke',
]);
// A short message opening with one of these also stops ("Stop texting me"): an opt-out by any
// reasonable means counts. CANCEL, END and QUIT only alone ("Cancel my 3pm" is not an opt-out).
const STOP_OPENERS = new Set(['stop', 'stopall', 'unsubscribe', 'optout', 'revoke']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);
const HELP_WORDS = new Set(['help', 'info']);
/** The longest message read as an opt-out by its first word. */
const STOP_OPENER_MAX_WORDS = 6;

/** What a reply asks for: a keyword in any case, punctuation ignored; `null` for anything else. */
export function classifySmsKeyword(body: string): SmsKeyword | null {
  const words = body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length === 0) return null;
  const text = words.join(' ');
  if (STOP_WORDS.has(text)) return 'stop';
  if (START_WORDS.has(text)) return 'start';
  if (HELP_WORDS.has(text)) return 'help';
  const [first = '', second = ''] = words;
  if (words.length <= STOP_OPENER_MAX_WORDS) {
    if (STOP_OPENERS.has(first) || (first === 'opt' && second === 'out')) return 'stop';
  }
  return null;
}

/**
 * Pepper's answers to the keywords (ADR-0065 §5), from Pepper's one sender: "Pepper" until
 * S61.2 names the business. `helpUrl` is the help centre, absolute.
 */
export function smsKeywordReply(keyword: SmsKeyword, helpUrl: string): string {
  switch (keyword) {
    case 'stop':
      return "Pepper: You're unsubscribed and won't get more texts from this number. Reply START to resubscribe.";
    case 'start':
      return "Pepper: You're resubscribed to appointment texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
    case 'help':
      return `Pepper: appointment texts from businesses you book with. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: ${helpUrl}`;
  }
}

/** How a consent was given (ADR-0065 §3): the booking page's box, or a member's own settings. */
export const SmsConsentSourceSchema = z.enum(['booking_page', 'member_settings']);
export type SmsConsentSource = z.infer<typeof SmsConsentSourceSchema>;

/**
 * The words a person agreed to, by version. A version is never edited: new words get a new
 * version, so every consent record says exactly what was shown. `{business}` is the name.
 */
export const SMS_CONSENT_WORDING = {
  'sms-consent-v1':
    'Text me appointment confirmations and reminders from {business} at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.',
} as const;
export const SmsConsentWordingVersionSchema = z.enum(['sms-consent-v1']);
export type SmsConsentWordingVersion = z.infer<typeof SmsConsentWordingVersionSchema>;
/** The wording shown with a new consent box. */
export const SMS_CONSENT_WORDING_CURRENT: SmsConsentWordingVersion = 'sms-consent-v1';

/** The consent wording with the business's name in it. */
export function smsConsentText(version: SmsConsentWordingVersion, business: string): string {
  // A function, so `$` in a name ("Nails $$ More") is never read as a replacement pattern.
  const name = business.trim();
  return SMS_CONSENT_WORDING[version].replace('{business}', () => name);
}

/**
 * Where a sent text stands, as Twilio reports it (AC-X-62). Callbacks arrive out of order, so a
 * status only replaces one of a lower rank; the final ones never change.
 */
export const SmsDeliveryStatusSchema = z.enum([
  'queued',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
]);
export type SmsDeliveryStatus = z.infer<typeof SmsDeliveryStatusSchema>;

const STATUS_RANK: Record<SmsDeliveryStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
};

/** Whether `next` may replace `current`: only forwards, and a final status stays. */
export function smsStatusMovesForward(
  current: SmsDeliveryStatus,
  next: SmsDeliveryStatus,
): boolean {
  return STATUS_RANK[next] > STATUS_RANK[current];
}

/** Twilio's status names, ours when they mean the same (`accepted`, `scheduled`: queued). */
export function smsDeliveryStatusOf(twilioStatus: string): SmsDeliveryStatus | null {
  switch (twilioStatus) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'sending':
    case 'sent':
    case 'delivered':
    case 'undelivered':
    case 'failed':
      return twilioStatus;
    case 'read':
      return 'delivered';
    default:
      return null;
  }
}

/** Twilio's error for a recipient who replied STOP to it: the number is opted out (AC-X-59). */
export const TWILIO_UNSUBSCRIBED_RECIPIENT = 21610;

/** A Twilio account id (`AC` and 32 hex digits). */
export const TwilioAccountSidSchema = z.string().regex(/^AC[0-9a-fA-F]{32}$/);
/** A Twilio message id (`SM` or `MM`, and 32 hex digits). */
export const TwilioMessageSidSchema = z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/);

/**
 * The fields of Twilio's incoming-message webhook that Pepper reads (AC-X-59, AC-X-61). Twilio
 * sends more; every field still counts for the signature.
 */
export const TwilioInboundSmsSchema = z.object({
  MessageSid: TwilioMessageSidSchema,
  AccountSid: TwilioAccountSidSchema,
  From: z.string().max(30),
  To: z.string().max(30),
  Body: z.string().max(2000).default(''),
});
export type TwilioInboundSms = z.infer<typeof TwilioInboundSmsSchema>;

/** The fields of Twilio's status callback that Pepper reads (AC-X-62). */
export const TwilioStatusCallbackSchema = z.object({
  MessageSid: TwilioMessageSidSchema,
  AccountSid: TwilioAccountSidSchema,
  MessageStatus: z.string().max(30),
  // A number, or `null` without one (Twilio may send none, or `0`, for no error).
  ErrorCode: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional()
    .transform((value) => (value === undefined || Number(value) === 0 ? null : Number(value))),
});
export type TwilioStatusCallback = z.infer<typeof TwilioStatusCallbackSchema>;

/**
 * The first instant at or after `instant` when a text may go out in `timeZone` (AC-X-60): the
 * instant itself inside the hours, else the next 8:00 there. 8:00 is never skipped or repeated
 * by a daylight-saving change (those happen at night), so the answer is exact on those days too.
 */
export function smsSendableAt(timeZone: string, instant: number): number {
  const start = SMS_QUIET_HOURS.startHour * 60;
  const end = SMS_QUIET_HOURS.endHour * 60;
  const local = toZoned(timeZone, instant);
  if (local.minuteOfDay >= start && local.minuteOfDay < end) return instant;
  const date = { year: local.year, month: local.month, day: local.day };
  // Before 8:00: today's; from 20:00: tomorrow's (24 h of minutes on, `fromZoned` rolls over).
  return fromZoned(timeZone, date, local.minuteOfDay < start ? start : start + 24 * 60);
}

/** The path of Twilio's status callback for one text (ADR-0065 §6), signed with its query. */
export const SMS_STATUS_CALLBACK_PATH = '/v1/webhooks/sms/status';

/** The status callback URL for a business's text: the business and the message in the query. */
export function smsStatusCallbackUrl(baseUrl: string, tenantId: string, messageId: string): string {
  const url = new URL(SMS_STATUS_CALLBACK_PATH, baseUrl);
  url.searchParams.set('t', tenantId);
  url.searchParams.set('m', messageId);
  return url.toString();
}
