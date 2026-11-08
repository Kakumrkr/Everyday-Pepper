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

/** Who solved a request (S59.2.2): the business, the Pepper team, or 7 quiet days (AC-X-24). */
export const SupportSolvedBySchema = z.enum(['member', 'pepper', 'auto']);
export type SupportSolvedBy = z.infer<typeof SupportSolvedBySchema>;

/** The opener's answer to "Did this help?" after a request is solved (S59.2.2, AC-X-26). */
export const SupportRatingSchema = z.enum(['helpful', 'not_helpful']);
export type SupportRating = z.infer<typeof SupportRatingSchema>;

/** A request quiet this long after the team's answer is closed by the support job (AC-X-24). */
export const SUPPORT_QUIET_DAYS = 7;
/** A request waiting on Pepper this long reminds the team: the same-day promise (AC-X-25). */
export const SUPPORT_OVERDUE_HOURS = 4;

export const SUPPORT_MESSAGE_MAX = 4_000;
/** New requests one person may open in a day (AC-X-14). */
export const SUPPORT_THREADS_PER_DAY = 5;
/** Messages one person may write in a day, across their threads. */
export const SUPPORT_MESSAGES_PER_DAY = 50;
/** Public requests an hour, per address and per email (AC-X-17). */
export const PUBLIC_SUPPORT_PER_HOUR = 3;

/** Screenshots one message may carry (S59.2.3, AC-X-27). */
export const SUPPORT_SCREENSHOTS_PER_MESSAGE = 3;
/** Screenshots one person may upload in a day, removed ones included (AC-X-28). */
export const SUPPORT_SCREENSHOTS_PER_DAY = 20;
/** The largest screenshot upload, in bytes (10 MB, as photos). */
export const SUPPORT_SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
/** An upload not sent within this many hours is deleted by the support job (AC-X-28). */
export const SUPPORT_SCREENSHOT_UNSENT_HOURS = 24;

export const SupportScreenshotIdSchema = z.uuid().brand<'SupportScreenshotId'>();
export type SupportScreenshotId = z.infer<typeof SupportScreenshotIdSchema>;

/** The two sizes a screenshot is served at: the thread's thumbnail and the full image. */
export const SupportScreenshotSizeSchema = z.enum(['thumb', 'full']);
export type SupportScreenshotSize = z.infer<typeof SupportScreenshotSizeSchema>;

/**
 * A stored screenshot (its upright size), served by `GET /v1/support/screenshots/:id` (members)
 * or `GET /v1/ops/screenshots/:id` (operators), `?size=thumb|full`. Also the upload's answer.
 */
export const SupportScreenshotSchema = z.object({
  id: SupportScreenshotIdSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type SupportScreenshot = z.infer<typeof SupportScreenshotSchema>;

/** The screenshots a request or reply carries: the ids of the sender's own uploads. */
const ScreenshotIdsSchema = z
  .array(SupportScreenshotIdSchema)
  .max(SUPPORT_SCREENSHOTS_PER_MESSAGE)
  .refine((ids) => new Set(ids).size === ids.length, 'Each screenshot once')
  .default([]);

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
    screenshotIds: ScreenshotIdsSchema,
  })
  .strict();
export type SupportThreadInput = z.input<typeof SupportThreadInputSchema>;

/** `POST /v1/support/threads/:id/messages`. */
export const SupportReplyInputSchema = z
  .object({ message: SupportMessageTextSchema, screenshotIds: ScreenshotIdsSchema })
  .strict();
export type SupportReplyInput = z.input<typeof SupportReplyInputSchema>;

/** `PATCH /v1/support/threads/:id`: the requester (or an owner or manager) marks it solved. */
export const SupportThreadChangeSchema = z.object({ status: z.literal('solved') }).strict();
export type SupportThreadChange = z.input<typeof SupportThreadChangeSchema>;

/** `PUT /v1/support/threads/:id/rating`: the opener's answer once it is solved (AC-X-26). */
export const SupportRatingInputSchema = z.object({ rating: SupportRatingSchema }).strict();
export type SupportRatingInput = z.input<typeof SupportRatingInputSchema>;

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

/** How a message came (S59.3): in the app, or a member's emailed reply. */
export const SupportMessageChannelSchema = z.enum(['app', 'email']);
export type SupportMessageChannel = z.infer<typeof SupportMessageChannelSchema>;

export const SupportMessageSchema = z.object({
  id: z.uuid(),
  author: SupportAuthorSchema,
  body: z.string(),
  /** The screenshots sent with it (S59.2.3), in their order. */
  screenshots: z.array(SupportScreenshotSchema),
  /** How it came (S59.3, AC-X-39): `email` is shown as "by email". */
  channel: SupportMessageChannelSchema,
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
  /** How many screenshots its messages carry (S59.2.3). */
  screenshotCount: z.number().int().nonnegative(),
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
  /** Who solved it (S59.2.2); `null` while open. `auto`: "Closed after 7 quiet days". */
  solvedBy: SupportSolvedBySchema.nullable(),
  /** "Did this help?": asked of the opener only, once solved (AC-X-26). */
  rating: z.object({ canRate: z.boolean(), value: SupportRatingSchema.nullable() }).strict(),
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
    /** The opener's "Did this help?" once solved (S59.2.2, AC-X-26). */
    rating: SupportRatingSchema.nullable(),
    /** How many screenshots it carries (S59.2.3, AC-X-30): "2 screenshots" in the row. */
    screenshotCount: z.number().int().nonnegative(),
  }),
  z.object({
    source: z.literal('public'),
    id: PublicSupportRequestIdSchema,
    reference: SupportReferenceSchema,
    status: PublicSupportStatusSchema,
    preview: z.string(),
    waitingSince: UtcDateTimeSchema,
    /** The signed-out form, or an email to the team's address (S59.3.2, AC-X-41). */
    channel: z.enum(['form', 'email']),
  }),
]);
export type OperatorInboxItem = z.infer<typeof OperatorInboxItemSchema>;

/** `GET /v1/ops/inbox`: the view's requests, the longest waiting first. */
export const OperatorInboxSchema = z.object({
  view: OperatorInboxViewSchema,
  items: z.array(OperatorInboxItemSchema),
  /** Requests waiting on Pepper, whatever the view. */
  waiting: z.number().int().nonnegative(),
  /** Held emails waiting for a look (S59.3.2, AC-X-46): "2 held" in the header. */
  held: z.number().int().nonnegative(),
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
  /** Its screenshots (S59.2.3); each image served is logged (`screenshot.read`, AC-X-30). */
  screenshots: z.array(SupportScreenshotSchema),
  /** How it came (S59.3, AC-X-39). */
  channel: SupportMessageChannelSchema,
  createdAt: UtcDateTimeSchema,
});
export type OperatorMessage = z.infer<typeof OperatorMessageSchema>;

/**
 * Support email to the requester is stopped (S59.3.2, AC-X-43): their address bounced for good or
 * they marked it as spam. An operator can resume it.
 */
export const SupportMailStopSchema = z.object({
  reason: z.enum(['bounced', 'complaint']),
  since: UtcDateTimeSchema,
});
export type SupportMailStop = z.infer<typeof SupportMailStopSchema>;

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
  /** Who solved it (S59.2.2); `null` while open. */
  solvedBy: SupportSolvedBySchema.nullable(),
  /** The opener's "Did this help?" (AC-X-26). */
  rating: SupportRatingSchema.nullable(),
  /** Whether support email to the opener is stopped (AC-X-43). */
  mailStopped: SupportMailStopSchema.nullable(),
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
  /** The signed-out form, or an email to the team's address (AC-X-41). */
  channel: z.enum(['form', 'email']),
  /** Whether support email to `email` is stopped (AC-X-43). */
  mailStopped: SupportMailStopSchema.nullable(),
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

// Held mail and inbound counts (S59.3.2, ADR-0063 Part 2, AC-X-44/45).

/** Why an email was held: its sender isn't one who may write there, or isn't verified. */
export const HeldReasonSchema = z.enum(['unknown_sender', 'unverified_sender']);
export type HeldReason = z.infer<typeof HeldReasonSchema>;

export const HeldEmailIdSchema = z.uuid().toLowerCase();

/** A held email in the console's "Held" view. Its text is shown as plain text, never rendered. */
export const OperatorHeldItemSchema = z.object({
  id: HeldEmailIdSchema,
  reason: HeldReasonSchema,
  /** A reply to a business's request, or a new request (a member's or a stranger's). */
  kind: z.enum(['reply', 'new_request']),
  from: z.string(),
  subject: z.string().nullable(),
  text: z.string(),
  /** The business it would go to; `null` for a stranger's. */
  business: z.string().nullable(),
  /** The request it replies to. */
  reference: SupportReferenceSchema.nullable(),
  heldSince: UtcDateTimeSchema,
});
export type OperatorHeldItem = z.infer<typeof OperatorHeldItemSchema>;

/** `GET /v1/ops/held`: held emails, the longest waiting first. */
export const OperatorHeldListSchema = z.object({ items: z.array(OperatorHeldItemSchema) });
export type OperatorHeldList = z.infer<typeof OperatorHeldListSchema>;

/** `POST /v1/ops/held/:id`: Accept lands it as if its check had passed; Discard empties it. */
export const OperatorHeldDecisionSchema = z
  .object({ decision: z.enum(['accept', 'discard']) })
  .strict();
export type OperatorHeldDecision = z.input<typeof OperatorHeldDecisionSchema>;

const InboundCountSchema = z.object({
  status: z.enum(['received', 'landed', 'held', 'ignored', 'refused', 'failed']),
  reason: z.string().nullable(),
  count: z.number().int().nonnegative(),
});

const InboundPeriodSchema = z.object({
  outcomes: z.array(InboundCountSchema),
  problems: z.object({
    hardBounces: z.number().int().nonnegative(),
    softBounces: z.number().int().nonnegative(),
    complaints: z.number().int().nonnegative(),
  }),
});

/** `GET /v1/ops/inbound/counts`: the last 7 and 30 days, for S59.4's metrics page. */
export const OperatorInboundCountsSchema = z.object({
  last7Days: InboundPeriodSchema,
  last30Days: InboundPeriodSchema,
});
export type OperatorInboundCounts = z.infer<typeof OperatorInboundCountsSchema>;

/** `GET /v1/ops/me`: the console opens for an operator only. */
export const OperatorMeSchema = z.object({ operator: z.literal(true), name: z.string() });
export type OperatorMe = z.infer<typeof OperatorMeSchema>;

/** At most this many saved replies (AC-X-23). */
export const SUPPORT_SAVED_REPLIES_MAX = 100;

export const SupportSavedReplyIdSchema = z.uuid().toLowerCase();

/** A saved reply of the team's (S59.2.2, AC-X-23): `{first name}` is filled in when used. */
export const SupportSavedReplySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  body: z.string(),
  updatedAt: UtcDateTimeSchema,
});
export type SupportSavedReply = z.infer<typeof SupportSavedReplySchema>;

/** `GET /v1/ops/replies`. */
export const SupportSavedReplyListSchema = z.object({
  replies: z.array(SupportSavedReplySchema),
});
export type SupportSavedReplyList = z.infer<typeof SupportSavedReplyListSchema>;

/** `POST /v1/ops/replies`, `PUT /v1/ops/replies/:id`. */
export const SupportSavedReplyInputSchema = z
  .object({
    title: z.string().trim().min(1, 'Give it a title.').max(80, 'Keep the title to 80 characters.'),
    body: SupportMessageTextSchema,
  })
  .strict();
export type SupportSavedReplyInput = z.input<typeof SupportSavedReplyInputSchema>;

/** The placeholder a saved reply may hold for the requester's first name. */
export const SAVED_REPLY_FIRST_NAME = '{first name}';
