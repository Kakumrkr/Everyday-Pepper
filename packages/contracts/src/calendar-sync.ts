import { z } from 'zod';
import { StaffMemberIdSchema } from './appointments.js';
import { MAX_LIST_ITEMS } from './bookings.js';
import { UtcDateTimeSchema } from './time.js';

// Google Calendar in (S70, ADR-0069): a staff member's Google busy times block their bookable
// time. Google's answers are outside input: every one is parsed here before it is used.

/** Where calendar busy times come from: Google, or the sandbox that never leaves the machine. */
export const CalendarProviderSchema = z.enum(['google', 'sandbox']);
export type CalendarProvider = z.infer<typeof CalendarProviderSchema>;

/** `needs_reconnect`: Google refused the refresh token (expired or revoked). */
export const CalendarConnectionStatusSchema = z.enum(['connected', 'needs_reconnect']);
export type CalendarConnectionStatus = z.infer<typeof CalendarConnectionStatusSchema>;

/** Why the last read of a calendar failed; stored as the code only. */
export const CalendarSyncErrorSchema = z.enum([
  'invalid_grant',
  'unauthorized',
  'rate_limited',
  'unavailable',
  'not_found',
  'bad_response',
  /** The sealed token can't be opened (the key changed): only a reconnect helps. */
  'token_unreadable',
]);
export type CalendarSyncError = z.infer<typeof CalendarSyncErrorSchema>;

/** The only Google scopes Pepper asks for in S70: who the account is, and free/busy times. */
export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.freebusy',
] as const;
export const GOOGLE_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';

/** How far ahead busy times are read (D-4): today and the next 60 days. */
export const CALENDAR_SYNC_DAYS = 60;
/** How often each connected calendar is read again (D-4). */
export const CALENDAR_SYNC_EVERY_MS = 5 * 60_000;
/** How long a "Connect Google Calendar" may take, from the start to Google's answer. */
export const CALENDAR_CONNECT_TTL_MS = 10 * 60_000;
/** At most this many busy times are kept from one read, the soonest (a 15-minute grid's worth). */
export const MAX_BUSY_BLOCKS_PER_READ = 6000;

// ---- Google's answers (developers.google.com, read 2026-11-25) ----

/** The token endpoint's answer to a code or a refresh token. */
export const GoogleTokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().min(1).max(86_400),
  /** Only with `access_type=offline` on the first consent; never on a refresh. */
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(2000),
  token_type: z.literal('Bearer'),
  id_token: z.string().min(1).max(8192).optional(),
});
export type GoogleTokenResponse = z.infer<typeof GoogleTokenResponseSchema>;

/** The token endpoint's error (`invalid_grant`: the refresh token expired or was revoked). */
export const GoogleTokenErrorSchema = z.object({
  error: z.string().max(100),
  error_description: z.string().max(1000).optional(),
});

/**
 * The claims Pepper reads from the ID token. It comes straight from Google's token endpoint over
 * HTTPS with the client secret, so its signature isn't checked (Google's OpenID Connect guide);
 * the issuer, the audience and the expiry are.
 */
export const GoogleIdTokenClaimsSchema = z.object({
  iss: z.enum(['https://accounts.google.com', 'accounts.google.com']),
  aud: z.string().min(1).max(500),
  sub: z.string().min(1).max(255),
  exp: z.number().int(),
  email: z.email().max(320),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
});
export type GoogleIdTokenClaims = z.infer<typeof GoogleIdTokenClaimsSchema>;

const GoogleDateTimeSchema = z.iso.datetime({ offset: true });

/** `freeBusy.query`'s answer for the calendars asked about (`primary` here). */
export const GoogleFreeBusyResponseSchema = z.object({
  kind: z.literal('calendar#freeBusy').optional(),
  timeMin: GoogleDateTimeSchema,
  timeMax: GoogleDateTimeSchema,
  calendars: z.record(
    z.string(),
    z.object({
      // A hard bound on what is parsed; what is kept is capped after merging (busyBlocksOf).
      busy: z
        .array(z.object({ start: GoogleDateTimeSchema, end: GoogleDateTimeSchema }))
        .max(50_000)
        .default([]),
      errors: z
        .array(z.object({ domain: z.string().max(200), reason: z.string().max(200) }))
        .max(50)
        .optional(),
    }),
  ),
});
export type GoogleFreeBusyResponse = z.infer<typeof GoogleFreeBusyResponseSchema>;

/** Calendar's 403 reasons that mean a rate limit, like its 429. */
export const GoogleRateLimitReasonSchema = z.enum([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
]);

/** Google's API error envelope (401 `authError`, 403/429 `rateLimitExceeded`…). */
export const GoogleApiErrorSchema = z.object({
  error: z.object({
    code: z.number().int(),
    message: z.string().max(2000).optional(),
    errors: z
      .array(z.object({ reason: z.string().max(200).optional() }))
      .max(20)
      .optional(),
  }),
});

// ---- Pepper's API ----

/** A staff member's connection as the app shows it; never a token. */
export const CalendarConnectionSchema = z.object({
  staffMemberId: StaffMemberIdSchema,
  provider: CalendarProviderSchema,
  accountEmail: z.string().min(3).max(320),
  status: CalendarConnectionStatusSchema,
  /** The last read of the busy times that worked; `null` before the first. */
  syncedAt: UtcDateTimeSchema.nullable(),
  connectedAt: UtcDateTimeSchema,
});
export type CalendarConnection = z.infer<typeof CalendarConnectionSchema>;

/** `GET /v1/calendar/google`: the signed-in member's own connection, if any. */
export const CalendarConnectionAnswerSchema = z.object({
  /** `false`: the signed-in member has no staff member to connect a calendar for. */
  canConnect: z.boolean(),
  connection: CalendarConnectionSchema.nullable(),
});
export type CalendarConnectionAnswer = z.infer<typeof CalendarConnectionAnswerSchema>;

/**
 * One staff member's calendar as their colleagues see it on the Team list (S70.2, AC-X-164,
 * AC-X-165): the state and when it was last read, never the Google account's email.
 */
export const TeamCalendarConnectionSchema = CalendarConnectionSchema.omit({ accountEmail: true });
export type TeamCalendarConnection = z.infer<typeof TeamCalendarConnectionSchema>;

/** `GET /v1/calendar/connections`: the business's connections, one per staff member at most. */
export const TeamCalendarConnectionsSchema = z.object({
  connections: z.array(TeamCalendarConnectionSchema).max(MAX_LIST_ITEMS),
  /** More connections than one answer holds: the list says nothing rather than guess. */
  truncated: z.boolean(),
});
export type TeamCalendarConnections = z.infer<typeof TeamCalendarConnectionsSchema>;

/** `POST /v1/calendar/google/connect`: where to send the member (Google's consent page). */
export const CalendarConnectStartSchema = z.object({ url: z.url().max(4000) });
export type CalendarConnectStart = z.infer<typeof CalendarConnectStartSchema>;

/** `POST /v1/calendar/google/callback`: what Google gave the return page. */
export const CalendarConnectCompleteSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .describe('The state Pepper made: 32 random bytes, base64url'),
  })
  .strict();
export type CalendarConnectComplete = z.infer<typeof CalendarConnectCompleteSchema>;

/** One busy time from a staff member's outside calendar: when, never what (ADR-0069 §4). */
export const OutsideBusyTimeSchema = z.object({
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  source: z.literal('google'),
});
export type OutsideBusyTime = z.infer<typeof OutsideBusyTimeSchema>;

/** `GET /v1/calendar/outside-busy` (the `BusyQuerySchema` query). */
export const OutsideBusyResponseSchema = z.object({
  busy: z.array(OutsideBusyTimeSchema).max(MAX_LIST_ITEMS),
  truncated: z.boolean(),
});
export type OutsideBusyResponse = z.infer<typeof OutsideBusyResponseSchema>;

/**
 * Google's busy times as Pepper stores them: clipped to the window read, adjacent or overlapping
 * ones merged, empty ones dropped, by start, the first `MAX_BUSY_BLOCKS_PER_READ` kept. Pure: the
 * sync and its tests share it.
 */
export function busyBlocksOf(
  busy: readonly { start: string; end: string }[],
  window: { from: number; to: number },
): { start: number; end: number }[] {
  const clipped = busy
    .map((b) => ({
      start: Math.max(Date.parse(b.start), window.from),
      end: Math.min(Date.parse(b.end), window.to),
    }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: { start: number; end: number }[] = [];
  for (const block of clipped) {
    const last = merged.at(-1);
    if (last !== undefined && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ ...block });
  }
  return merged.slice(0, MAX_BUSY_BLOCKS_PER_READ);
}
