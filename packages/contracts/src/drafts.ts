import { z } from 'zod';
import { looksLikeContact, StateFingerprintSchema } from './trust.js';

// Rebooking nudges (Phase 8, S36, ADR-0040): the morning drafts pass turns a regular who is due
// back, and an open time tomorrow, into a drafted email waiting for an owner's or manager's OK.
// The model writes only the subject and the body; the domain picks the client, the time, the
// booking link and the footer (business name, mailing address, one-click unsubscribe), checks
// the words, and sends nothing until a person approves the exact text they saw.

/** The draft writer's and the morning pass's limits (playbook §2: ≤ 1,500 tokens a draft). */
export const DRAFT_LIMITS = {
  /** Words in a body the model or a member writes. */
  maxWords: 120,
  subjectMax: 120,
  bodyMax: 1_200,
  /** Drafts one business gets in one local day (playbook D-9). */
  perBusinessPerDay: 20,
  /** One draft call: input and output together. */
  maxTokens: 1_500,
  maxOutputTokens: 400,
} as const;

/** The business's own words for its mailing address (CAN-SPAM: commercial mail carries it). */
export const MailingAddressSchema = z
  .string()
  .transform((value) =>
    value
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line !== '')
      .join('\n'),
  )
  .pipe(
    z
      .string()
      .min(5, 'Enter the street, city and ZIP code')
      .max(300)
      .refine((value) => value.split('\n').length <= 4, 'At most 4 lines')
      .refine((value) => !looksLikeContact(value), 'Only the postal address, no email or phone'),
  );
export type MailingAddress = z.infer<typeof MailingAddressSchema>;

// A web address or a bare domain the client could click: the domain adds the one link a nudge
// carries (the booking page), so words with any other are refused.
const LINK_LIKE =
  /(?:\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]{2,63}\.(?:com|net|org|io|co|us|app|link|ly|me|info|biz)\b)/i;

/** Whether `text` holds a web address or a bare domain. */
export function looksLikeLink(text: string): boolean {
  return LINK_LIKE.test(text);
}

/** How many words `text` has. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/**
 * A nudge's words, as the model returns them or a member edits them: one-line subject, a plain
 * text body of at most `DRAFT_LIMITS.maxWords` words, no link and no contact (the domain adds
 * the booking link and the footer). Sensitive remembered values are checked by the domain,
 * which knows them.
 */
export const NudgeDraftSchema = z
  .strictObject({
    subject: z
      .string()
      .transform((value) => value.replace(/\s+/g, ' ').trim())
      .pipe(z.string().min(1).max(DRAFT_LIMITS.subjectMax)),
    body: z
      .string()
      .transform((value) =>
        value
          .replace(/\r\n?/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim(),
      )
      .pipe(z.string().min(1).max(DRAFT_LIMITS.bodyMax)),
  })
  .superRefine((draft, ctx) => {
    if (wordCount(draft.body) > DRAFT_LIMITS.maxWords) {
      ctx.addIssue({
        code: 'custom',
        path: ['body'],
        message: `At most ${String(DRAFT_LIMITS.maxWords)} words`,
      });
    }
    for (const key of ['subject', 'body'] as const) {
      if (looksLikeLink(draft[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Leave links out: the booking link is added for you',
        });
      }
      if (looksLikeContact(draft[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'Leave email addresses and phone numbers out',
        });
      }
    }
  });
export type NudgeDraft = z.infer<typeof NudgeDraftSchema>;
export type NudgeDraftInput = z.input<typeof NudgeDraftSchema>;

/**
 * `POST /v1/ai/proposals/:id/draft`: the member's edited words and the fingerprint of the card
 * they edited. The proposal is replaced by one with the new words (a new fingerprint), which
 * the card then approves: an edited draft can never be sent unedited, nor an unseen one.
 */
export const EditDraftRequestSchema = z.strictObject({
  fingerprint: StateFingerprintSchema,
  subject: z.string().max(DRAFT_LIMITS.subjectMax * 2),
  body: z.string().max(DRAFT_LIMITS.bodyMax * 2),
});
export type EditDraftRequest = z.infer<typeof EditDraftRequestSchema>;

/**
 * The secret of a one-click unsubscribe link (base64url): the business and client it names,
 * signed by the api. It carries no address and needs no sign-in.
 */
export const UnsubscribeTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{40,300}$/, 'Not an unsubscribe link');
export type UnsubscribeToken = z.infer<typeof UnsubscribeTokenSchema>;

/** `GET` and `POST /v1/public/unsubscribe/:token`: the business, and whether it is done. */
export const UnsubscribeResponseSchema = z.strictObject({
  businessName: z.string().max(120),
  unsubscribed: z.boolean(),
});
export type UnsubscribeResponse = z.infer<typeof UnsubscribeResponseSchema>;
