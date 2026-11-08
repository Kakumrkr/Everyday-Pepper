import { z } from 'zod';

// The inbound email webhook (S59.3, ADR-0063): what Resend posts once its Svix signature has
// checked. Only what the job needs is read; the email itself is fetched from Resend's API by the
// worker, never taken from the webhook. Other fields pass through unread.

/**
 * A Resend webhook event: `email.received` is stored for the inbound job; `email.bounced` and
 * `email.complained` record a delivery problem (S59.3.2, AC-X-42); others are acknowledged only.
 */
export const ResendWebhookEventSchema = z.object({
  type: z.string().min(1).max(100),
  created_at: z.string().max(100).optional(),
  data: z
    .object({
      /** The received email's id at Resend (for `GET /emails/receiving/:id`). */
      email_id: z.string().min(1).max(200).optional(),
      /** The email's own `Message-ID`, when Resend reports it. */
      message_id: z.string().max(998).nullable().optional(),
      /** A sent email's recipients (`email.bounced`, `email.complained`; S59.3.2). */
      to: z.array(z.string().max(320)).max(50).optional(),
      /** Why it bounced: `Permanent` stops support mail, `Transient` is only counted. */
      bounce: z
        .object({
          type: z.string().max(50).optional(),
          subType: z.string().max(100).optional(),
        })
        .loose()
        .optional(),
    })
    .loose(),
});
export type ResendWebhookEvent = z.infer<typeof ResendWebhookEventSchema>;

/** The webhook's answer: always the same, so nothing is learnt from it. */
export const WebhookAckSchema = z.object({ received: z.literal(true) }).strict();
export type WebhookAck = z.infer<typeof WebhookAckSchema>;

/** The inbound domain (`INBOUND_EMAIL_DOMAIN`): a lowercase domain name, two labels or more. */
export const InboundDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{4,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/,
    'A domain such as reply.example.com',
  );
