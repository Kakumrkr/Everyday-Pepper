import { z } from 'zod';
import { PRIVACY_AI_SECTION, PRIVACY_PATH, privacyAiUrl } from './legal.js';
import { BookingTextKindSchema } from './reminders.js';
import { UtcDateTimeSchema } from './time.js';
import { normalizePhone } from './clients.js';
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

/** How a text whose words the AI wrote says so (S61.2, AC-X-69): it starts its last line. */
export const SMS_AI_DISCLOSURE_LEAD = 'Written with AI help:';

/** The disclosure's line: the lead and the privacy policy's AI section, absolute. */
export function smsAiDisclosure(baseUrl: string): string {
  return `${SMS_AI_DISCLOSURE_LEAD} ${privacyAiUrl(baseUrl)}`;
}

/** A text in the AI's words with its disclosure as the last line (ADR-0064 for texts). */
export function smsWithAiDisclosure(body: string, baseUrl: string): string {
  return `${body.trimEnd()}\n${smsAiDisclosure(baseUrl)}`;
}

/** Whether a text's last line is the disclosure, linking to the AI section. */
function endsWithAiDisclosure(body: string): boolean {
  const last = body.trimEnd().split('\n').at(-1) ?? '';
  return (
    last.startsWith(`${SMS_AI_DISCLOSURE_LEAD} `) &&
    /^https:\/\/\S+$/.test(last.slice(SMS_AI_DISCLOSURE_LEAD.length + 1)) &&
    last.endsWith(`${PRIVACY_PATH}#${PRIVACY_AI_SECTION}`)
  );
}

/**
 * What a text is about (S79, AC-X-221): `appointments` (confirmations, reminders, the confirm
 * ask, a member's own cards: what v1 and v2 name) or `waitlist_offer` (a freed time offered to
 * a waitlist client: what v3 names) or `reply` (S80, ADR-0072: a member's answer to the client's
 * own text, on any consent the client gave, v1 or v3). A consent lets the business send only its
 * purpose's texts.
 */
export const SmsPurposeSchema = z.enum(['appointments', 'waitlist_offer', 'reply']);
export type SmsPurpose = z.infer<typeof SmsPurposeSchema>;

/**
 * One text, as queued (ADR-0065 §2). Its content is sealed like an email's and cleared once
 * sent. `urgent`: about today's appointment (running late), so the quiet hours don't hold it;
 * set by domain code only, never from a model's arguments. `wordsBy` (S61.2, AC-X-69), always
 * said, so no caller can forget it: `ai` when the AI wrote the words, which then must end with
 * the disclosure (`smsWithAiDisclosure`, counted in the segments); `template` for Pepper's fixed
 * words; `member` for a member's own reply (S80). The link's host is the caller's (the app's
 * base URL); only its path is checked here.
 */
export const OutboxSmsSchema = z
  .object({
    to: SmsPhoneSchema,
    body: SmsBodySchema,
    urgent: z.literal(true).optional(),
    /**
     * The one text the person asked for just now (S63: a code to check their own number): sent
     * without a standing consent; a STOP still drops it.
     */
    requested: z.literal(true).optional(),
    wordsBy: z.enum(['ai', 'template', 'member']),
    /** What it is about (S79): checked at delivery against the consent; absent: appointments. */
    purpose: SmsPurposeSchema.optional(),
    /** Not sent after this instant (S79: a waitlist offer's close); dropped instead. */
    validUntil: UtcDateTimeSchema.optional(),
  })
  .strict()
  .refine((sms) => sms.wordsBy !== 'ai' || endsWithAiDisclosure(sms.body), {
    path: ['body'],
    message: 'A text in the AI’s words ends with its disclosure (smsWithAiDisclosure)',
  });
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
  // "Yes 4821" and "No 4821" answer an approval text (S63–S64): never a keyword.
  if (approvalReplyOf(body) !== null) return null;
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
 * What a reply to Pepper's number asks for, beyond the keywords (S62, AC-X-74): `confirm` for
 * "C" or "Confirm" ("C.", "c", "Confirmed", "confirm!" too), alone. An opt-out always wins: a
 * keyword is read first, so CANCEL, STOP and the rest never confirm.
 */
export type SmsReply =
  SmsKeyword | 'confirm' | 'approve' | 'approve_without_code' | 'skip' | 'skip_without_code';

const CONFIRM_WORDS = new Set(['c', 'confirm', 'confirmed']);

/**
 * A reply to an approval text (S63–S64, ADR-0066 §4): "Y" and its code approves the card, "N"
 * and its code skips it: "Y 4821", "y4821", "Yes 4821", "N: 4821.", "No 4821". Only with exactly
 * four digits; "YES" alone stays START.
 */
const APPROVAL_REPLY = /^(y|yes|n|no)\s*[-:.,]?\s*(\d{4})\s*[.!]?$/;

/** What a reply to an approval text decides. */
export type ApprovalDecision = 'approve' | 'skip';

/** The decision and code a reply carries ("N 4821" → skip "4821"); `null` for anything else. */
export function approvalReplyOf(body: string): { decision: ApprovalDecision; code: string } | null {
  const match = APPROVAL_REPLY.exec(body.normalize('NFKC').trim().toLowerCase());
  const [, word, code] = match ?? [];
  if (word === undefined || code === undefined) return null;
  return { decision: word.startsWith('y') ? 'approve' : 'skip', code };
}

/** The code an approving reply carries ("Y 4821" → "4821"); `null` for anything else. */
export function approvalCodeOf(body: string): string | null {
  const reply = approvalReplyOf(body);
  return reply?.decision === 'approve' ? reply.code : null;
}

/**
 * A reply's meaning: "Y" or "N" and a code (`approve`, `skip`) first, as no keyword carries
 * digits; then a keyword (`classifySmsKeyword`); then "C" to confirm, or "Y", "N" or "No" alone
 * (`approve_without_code`, `skip_without_code`, answered with how to reply); else `null`.
 */
export function classifySmsReply(body: string): SmsReply | null {
  const reply = approvalReplyOf(body);
  if (reply !== null) return reply.decision;
  const keyword = classifySmsKeyword(body);
  if (keyword !== null) return keyword;
  const words = body
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word !== '');
  if (words.length !== 1) return null;
  const [word = ''] = words;
  if (CONFIRM_WORDS.has(word)) return 'confirm';
  if (word === 'y') return 'approve_without_code';
  return word === 'n' || word === 'no' ? 'skip_without_code' : null;
}

/** The longest business name a reply carries before it is shortened (two fit in two segments). */
export const SMS_REPLY_NAME_MAX = 40;

/**
 * Who a reply comes from (S61.2, AC-X-68): the businesses the number said yes to (at most two,
 * the latest first; each shortened past `SMS_REPLY_NAME_MAX`), "via Pepper", whose one number
 * sends them; "Pepper" alone when there are none.
 */
export function smsReplySender(businesses: readonly string[]): string {
  const names = replyNames(businesses);
  return names.length === 0 ? 'Pepper' : `${names.join(' and ')} via Pepper`;
}

const isGsm7 = (char: string): boolean => GSM7_BASIC.has(char) || GSM7_EXTENSION.has(char);

/**
 * The names a reply carries: in GSM-7 only (a letter outside it as its plain letter, "ã" as
 * "a"; other characters dropped, so one emoji can't make the reply three times dearer), blank
 * ones left out, cut by character.
 */
function replyNames(businesses: readonly string[]): string[] {
  return businesses
    .map((name) => smsPlainText(name, Number.MAX_SAFE_INTEGER))
    .filter((name) => name !== '')
    .slice(0, 2)
    .map((name) => smsPlainText(name, SMS_REPLY_NAME_MAX));
}

/**
 * A name or other typed text as a text carries it (S62): on one line, in GSM-7 only (a letter
 * outside it as its plain letter, "ã" as "a"; other characters dropped, so one emoji can't make
 * a text three times dearer), cut at `max` characters with "...".
 */
export function smsPlainText(text: string, max: number): string {
  // By code point: every character outside GSM-7 (an emoji's parts too) is dropped below.
  const plain = Array.from(normalizeSmsText(text.replace(/\s+/g, ' ')))
    .map((char) => (isGsm7(char) ? char : (char.normalize('NFD')[0] ?? '')))
    .filter(isGsm7)
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim();
  // GSM-7 characters are one code unit each, so a plain cut never splits one.
  return plain.length > max ? `${plain.slice(0, Math.max(0, max - 3)).trimEnd()}...` : plain;
}

/**
 * Pepper's answers to the keywords (ADR-0065 §5), from Pepper's one sender, naming the
 * businesses the number said yes to (`smsReplySender`, S61.2). `helpUrl` is the help centre,
 * absolute. A STOP stops every business's texts to the number, and says so.
 */
export function smsKeywordReply(
  keyword: SmsKeyword,
  helpUrl: string,
  businesses: readonly string[] = [],
): string {
  const sender = smsReplySender(businesses);
  const named = replyNames(businesses).length > 0;
  switch (keyword) {
    case 'stop':
      return named
        ? `${sender}: You're unsubscribed and won't get more texts from this number, from any business. Reply START to resubscribe.`
        : `${sender}: You're unsubscribed and won't get more texts from this number. Reply START to resubscribe.`;
    case 'start':
      return `${sender}: You're resubscribed to appointment texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`;
    case 'help':
      return named
        ? `${sender}: appointment texts. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: ${helpUrl}`
        : `${sender}: appointment texts from businesses you book with. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: ${helpUrl}`;
  }
}

/**
 * How a consent was given (ADR-0065 §3): the booking page's box, a member's own settings, the
 * booking page's "Join the waitlist" box (S79), or the team recording what a client agreed to
 * when adding them to the waitlist (S79). One is in force a number and source, so a client's
 * waitlist consent stands beside their reminder consent.
 */
export const SmsConsentSourceSchema = z.enum([
  'booking_page',
  'member_settings',
  'waitlist_join',
  'staff_recorded',
]);
export type SmsConsentSource = z.infer<typeof SmsConsentSourceSchema>;

/**
 * The words a person agreed to, by version. A version is never edited: new words get a new
 * version, so every consent record says exactly what was shown. `{business}` is the name.
 */
export const SMS_CONSENT_WORDING = {
  'sms-consent-v1':
    'Text me appointment confirmations and reminders from {business} at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to book.',
  // A member's own cards by text (S63, ADR-0066 §2).
  'sms-consent-v2':
    'Text me cards that need my OK from {business} at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.',
  // A waitlist client's offers (S79, ADR-0065 §S79): only the openings they asked for.
  'sms-consent-v3':
    "Text me when a time I'm waiting for opens up at {business}, at this number. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Not required to join.",
} as const;
export const SmsConsentWordingVersionSchema = z.enum([
  'sms-consent-v1',
  'sms-consent-v2',
  'sms-consent-v3',
]);
export type SmsConsentWordingVersion = z.infer<typeof SmsConsentWordingVersionSchema>;
/** The wording shown with a new consent box. */
export const SMS_CONSENT_WORDING_CURRENT: SmsConsentWordingVersion = 'sms-consent-v1';
/** The wording a member agrees to when they turn "Text me cards" on (S63). */
export const SMS_MEMBER_CONSENT_WORDING: SmsConsentWordingVersion = 'sms-consent-v2';
/** The wording of the "Join the waitlist" box and the team's "They agreed to texts" (S79). */
export const SMS_WAITLIST_CONSENT_WORDING: SmsConsentWordingVersion = 'sms-consent-v3';

/** The wording versions whose consent allows each purpose's texts (never v3 for reminders). */
export const SMS_PURPOSE_WORDINGS: Record<SmsPurpose, readonly SmsConsentWordingVersion[]> = {
  appointments: ['sms-consent-v1', 'sms-consent-v2'],
  waitlist_offer: ['sms-consent-v3'],
  // An answer to a text the client sent (S80): conversational, on whichever consent they gave.
  reply: ['sms-consent-v1', 'sms-consent-v3'],
};

/** The wording versions each source may record (the database checks the same, migration 0093). */
export const SMS_SOURCE_WORDINGS: Record<SmsConsentSource, readonly SmsConsentWordingVersion[]> = {
  booking_page: ['sms-consent-v1'],
  member_settings: ['sms-consent-v2'],
  waitlist_join: ['sms-consent-v3'],
  staff_recorded: ['sms-consent-v3'],
};

/** A wording version that `source` may record (S79): a box can't be sent another's words. */
export function smsConsentVersionFor(source: SmsConsentSource) {
  return SmsConsentWordingVersionSchema.refine(
    (version) => SMS_SOURCE_WORDINGS[source].includes(version),
    { message: 'This consent box shows other words' },
  );
}

/** The consent wording with the business's name in it. */
export function smsConsentText(version: SmsConsentWordingVersion, business: string): string {
  // A function, so `$` in a name ("Nails $$ More") is never read as a replacement pattern.
  const name = business.trim();
  return SMS_CONSENT_WORDING[version].replace('{business}', () => name);
}

/**
 * Where a client's texts stand, for their profile (S61.2, AC-X-66): `on` (a consent in force);
 * `opted_out` (a consent, but the number replied STOP, for every business on Pepper);
 * `stopped` (the latest consent was revoked: a member stopped them, or another client took the
 * number); `never` (no consent on record).
 */
export const ClientTextsStatusSchema = z.enum(['on', 'opted_out', 'stopped', 'never']);
export type ClientTextsStatus = z.infer<typeof ClientTextsStatusSchema>;

/**
 * Where the client's last text stands (S62 top-up, AC-X-76): `waiting` (queued, held for the
 * quiet hours or about to go; `at` is when it may go), `sent` (the provider took it; no report
 * yet), `delivered`, `not_delivered` (the carrier couldn't deliver it), `not_sent` (dropped at
 * send time: `reason` says why).
 */
export const LastTextStateSchema = z.enum([
  'waiting',
  'sent',
  'delivered',
  'not_delivered',
  'not_sent',
]);
export type LastTextState = z.infer<typeof LastTextStateSchema>;

export const LastTextReasonSchema = z.enum(['opted_out', 'no_consent', 'not_textable', 'failed']);
export type LastTextReason = z.infer<typeof LastTextReasonSchema>;

export const LastTextSchema = z
  .object({
    kind: BookingTextKindSchema,
    /** When it went; while `waiting`, when it may go. */
    at: UtcDateTimeSchema,
    state: LastTextStateSchema,
    reason: LastTextReasonSchema.nullable(),
  })
  .strict();
export type LastText = z.infer<typeof LastTextSchema>;

/** How many days after a business's last text to a number a reply from it comes back (S80). */
export const CLIENT_TEXT_WINDOW_DAYS = 7;
/** How long a client's text and a reply are kept (S80, ADR-0072, AC-X-235). */
export const CLIENT_TEXT_RETENTION_DAYS = 90;
/** The most a member's reply may say (S80, AC-X-233); the business's name goes before it. */
export const CLIENT_TEXT_REPLY_MAX = 300;

/** What a consent in force lets the business text (S80 top-up, AC-X-236). */
export const SmsConsentPurposeSchema = z.enum(['appointments', 'waitlist_offer']);

/** One consent in force on the client's profile, with what it is for (AC-X-236). */
export const ClientTextsConsentSchema = z
  .object({
    phone: SmsPhoneSchema,
    purpose: SmsConsentPurposeSchema,
    source: SmsConsentSourceSchema,
    wordingVersion: SmsConsentWordingVersionSchema,
    words: z.string().min(1),
    givenAt: UtcDateTimeSchema,
    /** The number replied STOP (for every business on Pepper). */
    optedOut: z.boolean(),
  })
  .strict();
export type ClientTextsConsent = z.infer<typeof ClientTextsConsentSchema>;

/** A client's own text or a member's reply, on the profile (S80, AC-X-234). */
export const ClientTextEntrySchema = z
  .object({
    id: z.uuid(),
    from: z.enum(['client', 'team']),
    body: z.string().min(1).max(1600),
    at: UtcDateTimeSchema,
  })
  .strict();
export type ClientTextEntry = z.infer<typeof ClientTextEntrySchema>;

/** `POST /v1/clients/:clientId/texts/replies`: a member's reply, from its card or the profile. */
export const ClientTextReplyRequestSchema = z
  .object({
    body: z.string().trim().min(1, 'Write a reply').max(CLIENT_TEXT_REPLY_MAX),
    /** The card it answers, closed as done. */
    feedItemId: z.uuid().optional(),
  })
  .strict();
export type ClientTextReplyRequest = z.infer<typeof ClientTextReplyRequestSchema>;

/** The queued reply: Undo takes it back (`DELETE …/replies/:replyId`) until `sendsAt` passes. */
export const ClientTextReplySchema = z
  .object({
    replyId: z.uuid(),
    /** When it may go out (after the hold and the quiet hours). */
    sendsAt: UtcDateTimeSchema,
  })
  .strict();
export type ClientTextReply = z.infer<typeof ClientTextReplySchema>;

/** What Undo did: `taken_back`, or `too_late` (it is being sent or was sent). */
export const ClientTextUndoSchema = z
  .object({ outcome: z.enum(['taken_back', 'too_late']) })
  .strict();

/**
 * `GET /v1/clients/:clientId/texts` (and the answer of `POST …/texts/stop`): the status, the
 * client's latest consent with the words exactly as shown, whether their own phone can get texts
 * (`textable`: US or Canada), whether this member may stop them (`canStop`) and the last text
 * the business sent them (`lastText`, S62; `null` for none).
 */
export const ClientTextsSchema = z.object({
  status: ClientTextsStatusSchema,
  textable: z.boolean(),
  consent: z
    .object({
      phone: SmsPhoneSchema,
      source: SmsConsentSourceSchema,
      wordingVersion: SmsConsentWordingVersionSchema,
      words: z.string().min(1),
      givenAt: UtcDateTimeSchema,
      stoppedAt: UtcDateTimeSchema.nullable(),
    })
    .nullable(),
  canStop: z.boolean(),
  lastText: LastTextSchema.nullable(),
  /** Each consent in force, with its purpose (S80 top-up, AC-X-236). */
  consents: z.array(ClientTextsConsentSchema),
  /** Their own texts and the replies, newest first (S80, AC-X-234). */
  messages: z.array(ClientTextEntrySchema),
  /** Whether this member may reply by text now (owners and managers, a consent in force). */
  canReply: z.boolean(),
});
export type ClientTexts = z.infer<typeof ClientTextsSchema>;

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

/** A code Pepper texts to check a member's own number (S63, AC-X-80): six digits. */
export const PhoneCheckCodeSchema = z.string().regex(/^\d{6}$/, 'Use the 6-digit code');
export type PhoneCheckCode = z.infer<typeof PhoneCheckCodeSchema>;

/** `POST /v1/me/phone`: the number to check (US or Canada, any common format). */
export const StartPhoneCheckRequestSchema = z.object({ phone: z.string().max(40) }).strict();
export type StartPhoneCheckRequest = z.infer<typeof StartPhoneCheckRequestSchema>;

/** `POST /v1/me/phone`'s answer: until when the code works. */
export const StartPhoneCheckResponseSchema = z.object({ expiresAt: UtcDateTimeSchema }).strict();
export type StartPhoneCheckResponse = z.infer<typeof StartPhoneCheckResponseSchema>;

/** `POST /v1/me/phone/verify`: the code from the text. */
export const VerifyPhoneRequestSchema = z.object({ code: PhoneCheckCodeSchema }).strict();
export type VerifyPhoneRequest = z.infer<typeof VerifyPhoneRequestSchema>;

/**
 * The member's own texts in this business (S63, AC-X-80/81): their checked number (`null`:
 * none yet), whether "Text me cards" is on here, and whether their role may turn it on
 * (owners and managers).
 */
export const MemberTextsSchema = z
  .object({
    phone: SmsPhoneSchema.nullable(),
    cardTexts: z.boolean(),
    canTextCards: z.boolean(),
  })
  .strict();
export type MemberTexts = z.infer<typeof MemberTextsSchema>;

/** `PATCH /v1/me/texts`. */
export const UpdateMemberTextsRequestSchema = z.object({ cardTexts: z.boolean() }).strict();
export type UpdateMemberTextsRequest = z.infer<typeof UpdateMemberTextsRequestSchema>;

/** `POST /v1/dev/sms/inbound` (S63, AC-X-87): a text to Pepper's number, in the sandbox only. */
export const SandboxInboundSmsRequestSchema = z
  .object({ from: z.string().max(40), body: z.string().max(1600) })
  .strict();
export type SandboxInboundSmsRequest = z.infer<typeof SandboxInboundSmsRequestSchema>;

/** Its answer: the reply Pepper sends back (`null`: none), as Twilio's TwiML would carry it. */
export const SandboxInboundSmsResponseSchema = z.object({ reply: z.string().nullable() }).strict();
export type SandboxInboundSmsResponse = z.infer<typeof SandboxInboundSmsResponseSchema>;

/** `GET /v1/dev/sms/sent?to=`: the texts the sandbox sent to a number, the newest first. */
export const SandboxSentSmsResponseSchema = z
  .object({
    texts: z.array(
      z.object({ to: z.string(), body: z.string(), sentAt: UtcDateTimeSchema }).strict(),
    ),
  })
  .strict();
export type SandboxSentSmsResponse = z.infer<typeof SandboxSentSmsResponseSchema>;

/** `GET /v1/dev/sms/sent`'s query: the number, in any common form. */
export const SandboxSentSmsQuerySchema = z
  .object({ to: z.string().max(40).transform(normalizePhone).pipe(SmsPhoneSchema) })
  .strict();
