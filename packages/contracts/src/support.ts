import { z } from 'zod';
import { MembershipRoleSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// Pepper's own support (S59, PCR-010, AC-X-13…18). A member of a business opens a request
// ("Tell us what went wrong"); it is a thread the Pepper team answers (S59.2's console, S59.3's
// email). Someone who can't sign in uses the public form instead: it reaches the team, never
// the address they typed. The message is the writer's own free text: it is stored, shown to
// the people who may read the thread and emailed to the team, and never logged or audited.

/** A support thread: a lowercased UUID. */
export const SupportThreadIdSchema = z.uuid().toLowerCase().brand<'SupportThreadId'>();
export type SupportThreadId = z.infer<typeof SupportThreadIdSchema>;

/**
 * What people quote to the team: "PEP-" and 6 characters of Crockford's base 32 (no I, L, O
 * or U, so it reads back over the phone).
 */
export const SupportReferenceSchema = z
  .string()
  .regex(/^PEP-[0-9A-HJKMNP-TV-Z]{6}$/, 'A reference such as PEP-7K3Q9D');
export type SupportReference = z.infer<typeof SupportReferenceSchema>;

/** What a request is about: something broken, a question, or an idea. */
export const SupportKindSchema = z.enum(['problem', 'question', 'idea']);
export type SupportKind = z.infer<typeof SupportKindSchema>;

/**
 * Where a thread stands: the team owes an answer, the team answered (the requester's turn), or
 * it is solved. A reply from the requester always puts it back to `waiting_on_pepper`.
 */
export const SupportStatusSchema = z.enum(['waiting_on_pepper', 'pepper_replied', 'solved']);
export type SupportStatus = z.infer<typeof SupportStatusSchema>;

export const SUPPORT_MESSAGE_MAX = 4_000;
/** New requests one person may open in a day (AC-X-14). */
export const SUPPORT_THREADS_PER_DAY = 5;
/** Messages one person may write in a day, across their threads. */
export const SUPPORT_MESSAGES_PER_DAY = 50;
/** Public requests an hour, per address and per email (AC-X-17). */
export const PUBLIC_SUPPORT_PER_HOUR = 3;

export const SupportMessageTextSchema = z
  .string()
  // Line endings as one kind; no control characters other than line breaks and tabs.
  .transform((value) => value.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1, 'Write a few words')
      .max(SUPPORT_MESSAGE_MAX, `At most ${String(SUPPORT_MESSAGE_MAX)} characters`)
      // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
      .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value), {
        message: 'Remove the hidden characters',
      }),
  );

/** An app path such as `/clients/import`: no host, no scheme, no `//`. */
const AppPathSchema = z
  .string()
  .max(200)
  .regex(/^\/(?!\/)[A-Za-z0-9\-._~/%]*$/, 'An app path such as /calendar');

/** A help article's slug (`/help/<slug>`). */
export const HelpArticleSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);
export type HelpArticleSlug = z.infer<typeof HelpArticleSlugSchema>;

/**
 * What the browser adds to a request: the page it was sent from, the screen's size, the help
 * article it came from and, from an error state, the error's reference (a Next.js digest or
 * an api request id). The app version, the browser and the business's setup state are added
 * by the server; nothing here can carry client data.
 */
export const SupportContextInputSchema = z
  .object({
    page: AppPathSchema.optional(),
    viewport: z
      .object({
        width: z.number().int().min(1).max(10_000),
        height: z.number().int().min(1).max(10_000),
      })
      .strict()
      .optional(),
    topic: HelpArticleSlugSchema.optional(),
    errorRef: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,100}$/)
      .optional(),
  })
  .strict();
export type SupportContextInput = z.input<typeof SupportContextInputSchema>;

/** The context as stored and shown to the team: the browser's part and the server's. */
export const SupportContextSchema = SupportContextInputSchema.extend({
  /** The api's release (`RELEASE`), or `unknown`. */
  appVersion: z.string().max(100),
  /** The browser's `User-Agent`, cut to 300 characters. */
  userAgent: z.string().max(300).nullable(),
  role: MembershipRoleSchema,
  /** The business's first steps (ADR-0046), read when the request was opened. */
  setup: z
    .object({
      bookable: z.boolean(),
      firstBooking: z.boolean(),
    })
    .strict(),
}).strict();
export type SupportContext = z.infer<typeof SupportContextSchema>;

/** `POST /v1/support/threads`. */
export const SupportThreadInputSchema = z
  .object({
    kind: SupportKindSchema,
    message: SupportMessageTextSchema,
    context: SupportContextInputSchema.default({}),
  })
  .strict();
export type SupportThreadInput = z.input<typeof SupportThreadInputSchema>;

/** `POST /v1/support/threads/:id/messages`. */
export const SupportReplyInputSchema = z.object({ message: SupportMessageTextSchema }).strict();
export type SupportReplyInput = z.input<typeof SupportReplyInputSchema>;

/** `PATCH /v1/support/threads/:id`: the requester (or an owner or manager) marks it solved. */
export const SupportThreadChangeSchema = z.object({ status: z.literal('solved') }).strict();
export type SupportThreadChange = z.input<typeof SupportThreadChangeSchema>;

/**
 * Who wrote a message, as the reader sees it: themselves, a teammate (by name), a member whose
 * account is gone, or the Pepper team.
 */
export const SupportAuthorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('you') }).strict(),
  z.object({ kind: z.literal('teammate'), name: z.string() }).strict(),
  z.object({ kind: z.literal('former_member') }).strict(),
  z.object({ kind: z.literal('pepper') }).strict(),
]);
export type SupportAuthor = z.infer<typeof SupportAuthorSchema>;

export const SupportMessageSchema = z.object({
  id: z.uuid(),
  author: SupportAuthorSchema,
  body: z.string(),
  createdAt: UtcDateTimeSchema,
});
export type SupportMessage = z.infer<typeof SupportMessageSchema>;

/** A thread in "Your requests". `unread`: the team answered since the requester last looked. */
export const SupportThreadSummarySchema = z.object({
  id: SupportThreadIdSchema,
  reference: SupportReferenceSchema,
  kind: SupportKindSchema,
  status: SupportStatusSchema,
  /** The start of the first message, at most 140 characters. */
  preview: z.string(),
  /** Who opened it, as the reader sees them. */
  openedBy: SupportAuthorSchema,
  unread: z.boolean(),
  createdAt: UtcDateTimeSchema,
  lastMessageAt: UtcDateTimeSchema,
});
export type SupportThreadSummary = z.infer<typeof SupportThreadSummarySchema>;

export const SupportThreadListSchema = z.object({
  threads: z.array(SupportThreadSummarySchema),
  /** Threads with an unread answer, for More's count. */
  unread: z.number().int().nonnegative(),
});
export type SupportThreadList = z.infer<typeof SupportThreadListSchema>;

export const SupportThreadSchema = SupportThreadSummarySchema.extend({
  messages: z.array(SupportMessageSchema),
  /** The email address the team's answers are sent to: the requester's. `null` for others. */
  replyTo: z.string().nullable(),
});
export type SupportThread = z.infer<typeof SupportThreadSchema>;

/** `GET /v1/support/unread`: More's count. */
export const SupportUnreadSchema = z.object({ unread: z.number().int().nonnegative() });
export type SupportUnread = z.infer<typeof SupportUnreadSchema>;

/** `POST /v1/public/support`: someone who can't sign in. `website` is the hidden honeypot. */
export const PublicSupportInputSchema = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().max(100).optional(),
    message: SupportMessageTextSchema,
    page: AppPathSchema.optional(),
    topic: HelpArticleSlugSchema.optional(),
    website: z.string().max(200).optional(),
  })
  .strict();
export type PublicSupportInput = z.input<typeof PublicSupportInputSchema>;

/** The answer to a new request, public or not. */
export const SupportCreatedSchema = z.object({
  reference: SupportReferenceSchema,
  /** The thread (signed-in requests only). */
  id: SupportThreadIdSchema.nullable(),
  /** Where the answer goes. */
  replyTo: z.string(),
});
export type SupportCreated = z.infer<typeof SupportCreatedSchema>;
