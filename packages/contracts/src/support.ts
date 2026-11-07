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
  /** When the Pepper team last opened it (S59.2, AC-X-22); `null`: not yet. */
  seenByPepperAt: UtcDateTimeSchema.nullable(),
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

// The operator console (S59.2, ADR-0062, AC-X-19…22): Pepper's own team, across businesses.

/** A public request's status: open (waits on Pepper), answered (by email), solved. */
export const PublicSupportStatusSchema = z.enum(['open', 'answered', 'solved']);
export type PublicSupportStatus = z.infer<typeof PublicSupportStatusSchema>;

export const PublicSupportRequestIdSchema = z
  .uuid()
  .toLowerCase()
  .brand<'PublicSupportRequestId'>();

/** The inbox's three views: waiting on Pepper, answered (waiting on them), solved. */
export const OperatorInboxViewSchema = z.enum(['waiting', 'answered', 'solved']);
export type OperatorInboxView = z.infer<typeof OperatorInboxViewSchema>;

export const OperatorInboxQuerySchema = z
  .object({ view: OperatorInboxViewSchema.default('waiting') })
  .strict();
export type OperatorInboxQuery = z.input<typeof OperatorInboxQuerySchema>;

export const OperatorInboxItemSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('thread'),
    id: SupportThreadIdSchema,
    reference: SupportReferenceSchema,
    kind: SupportKindSchema,
    status: SupportStatusSchema,
    /** The business's name. */
    business: z.string(),
    preview: z.string(),
    /** Since when it waits (the oldest message not answered yet), for "3 h waiting". */
    waitingSince: UtcDateTimeSchema,
  }),
  z.object({
    source: z.literal('public'),
    id: PublicSupportRequestIdSchema,
    reference: SupportReferenceSchema,
    status: PublicSupportStatusSchema,
    preview: z.string(),
    waitingSince: UtcDateTimeSchema,
  }),
]);
export type OperatorInboxItem = z.infer<typeof OperatorInboxItemSchema>;

/** `GET /v1/ops/inbox`: the view's requests, the longest waiting first. */
export const OperatorInboxSchema = z.object({
  view: OperatorInboxViewSchema,
  items: z.array(OperatorInboxItemSchema),
  /** Requests waiting on Pepper, whatever the view. */
  waiting: z.number().int().nonnegative(),
});
export type OperatorInbox = z.infer<typeof OperatorInboxSchema>;

/** A note of the team's, never shown to a member. */
export const SupportNoteSchema = z.object({
  id: z.uuid(),
  /** The operator's name; `null` once their account is gone. */
  author: z.string().nullable(),
  body: z.string(),
  createdAt: UtcDateTimeSchema,
});
export type SupportNote = z.infer<typeof SupportNoteSchema>;

/** Who wrote a message, as the console shows it. */
export const OperatorMessageSchema = z.object({
  id: z.uuid(),
  author: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('member'), name: z.string().nullable() }).strict(),
    z.object({ kind: z.literal('pepper') }).strict(),
  ]),
  body: z.string(),
  createdAt: UtcDateTimeSchema,
});
export type OperatorMessage = z.infer<typeof OperatorMessageSchema>;

/** `GET /v1/ops/threads/:id`: a business's request, as the console opens it. */
export const OperatorThreadSchema = z.object({
  id: SupportThreadIdSchema,
  reference: SupportReferenceSchema,
  kind: SupportKindSchema,
  status: SupportStatusSchema,
  business: z.string(),
  /** The opener's name and role; `null` once their account is gone. */
  openedBy: z.object({ name: z.string(), role: z.string().nullable() }).nullable(),
  /** What the request was sent with (page, version, browser, setup state): never client data. */
  context: SupportContextSchema.nullable(),
  messages: z.array(OperatorMessageSchema),
  notes: z.array(SupportNoteSchema),
  createdAt: UtcDateTimeSchema,
  lastMessageAt: UtcDateTimeSchema,
});
export type OperatorThread = z.infer<typeof OperatorThreadSchema>;

/** `GET /v1/ops/requests/:id`: a public request. */
export const OperatorPublicRequestSchema = z.object({
  id: PublicSupportRequestIdSchema,
  reference: SupportReferenceSchema,
  status: PublicSupportStatusSchema,
  email: z.string(),
  name: z.string().nullable(),
  body: z.string(),
  page: z.string().nullable(),
  topic: z.string().nullable(),
  notes: z.array(SupportNoteSchema),
  createdAt: UtcDateTimeSchema,
});
export type OperatorPublicRequest = z.infer<typeof OperatorPublicRequestSchema>;

/** `POST /v1/ops/…/:id/notes`. */
export const SupportNoteInputSchema = z.object({ note: SupportMessageTextSchema }).strict();
export type SupportNoteInput = z.input<typeof SupportNoteInputSchema>;

/** `PATCH /v1/ops/threads/:id`: any status. */
export const OperatorThreadChangeSchema = z.object({ status: SupportStatusSchema }).strict();
export type OperatorThreadChange = z.input<typeof OperatorThreadChangeSchema>;

/** `PATCH /v1/ops/requests/:id`: any status. */
export const OperatorPublicChangeSchema = z.object({ status: PublicSupportStatusSchema }).strict();
export type OperatorPublicChange = z.input<typeof OperatorPublicChangeSchema>;

/** `GET /v1/ops/me`: the console opens for an operator only. */
export const OperatorMeSchema = z.object({ operator: z.literal(true), name: z.string() });
export type OperatorMe = z.infer<typeof OperatorMeSchema>;
