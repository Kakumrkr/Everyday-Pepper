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
  /** Google refused the call for a missing permission (a 403 that isn't a rate limit, S71). */
  'forbidden',
  'bad_response',
  /** The sealed token can't be opened (the key changed): only a reconnect helps. */
  'token_unreadable',
]);
export type CalendarSyncError = z.infer<typeof CalendarSyncErrorSchema>;

export const GOOGLE_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
/**
 * A calendar Pepper makes in the account and the events on it (S71, D-2): never the member's
 * other calendars. Optional on Google's page: without it the connection reads busy times only.
 */
export const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

/**
 * The only Google scopes Pepper asks for: who the account is, free/busy times (S70) and the
 * "Pepper bookings" calendar (S71), in one consent.
 */
export const GOOGLE_CALENDAR_SCOPES = [
  'openid',
  'email',
  GOOGLE_FREEBUSY_SCOPE,
  GOOGLE_EVENTS_SCOPE,
] as const;

/** How far ahead busy times are read (D-4): today and the next 60 days. */
export const CALENDAR_SYNC_DAYS = 60;
/** How often each connected calendar is read again (D-4). */
export const CALENDAR_SYNC_EVERY_MS = 5 * 60_000;
/** How long a "Connect Google Calendar" may take, from the start to Google's answer. */
export const CALENDAR_CONNECT_TTL_MS = 10 * 60_000;
/** At most this many busy times are kept from one read, the soonest (a 15-minute grid's worth). */
export const MAX_BUSY_BLOCKS_PER_READ = 6000;

// ---- Google Calendar out (S71, ADR-0069 §10) ----

/** The calendar Pepper makes in the staff member's account and writes bookings into (D-2). */
export const PEPPER_CALENDAR_NAME = 'Pepper bookings';
/** On the grant, bookings starting in the next this many days are written (D-4). */
export const CALENDAR_WRITE_BACKFILL_DAYS = 60;
/** How long one write pass holds a booking's row: no other worker writes it meanwhile. */
export const CALENDAR_WRITE_LEASE_MS = 2 * 60_000;
/** The longest wait between two tries of a failing write. */
export const CALENDAR_WRITE_MAX_BACKOFF_MS = 60 * 60_000;

/** When a failing write is tried again: 1, 2, 4… minutes after its `attempts`-th try, at most an hour. */
export function calendarWriteBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(attempts, 1) - 1, 10);
  return Math.min(60_000 * 2 ** exponent, CALENDAR_WRITE_MAX_BACKOFF_MS);
}

/**
 * The Google event id of a booking (AC-X-169): base32hex (`0-9a-v`), from the booking's UUID, so
 * every write of one booking names the same event and a retry can never make a second.
 */
export function calendarEventIdOf(bookingId: string): string {
  const hex = z.uuid().parse(bookingId).toLowerCase().replaceAll('-', '');
  return `pepper${hex}`;
}

/** What a booking's event says (D-3): the service and the client's first name, never contact details. */
export interface BookingEventFacts {
  bookingId: string;
  serviceName: string;
  /** The client's first name only; empty when unknown. */
  clientFirstName: string;
  startsAt: Date;
  endsAt: Date;
}

/** The body Pepper sends for a booking's event (events.insert/patch), private and opaque. */
export function calendarEventBodyOf(facts: BookingEventFacts) {
  const service = oneLine(facts.serviceName, 120) || 'Appointment';
  const client = oneLine(facts.clientFirstName, 60);
  return {
    id: calendarEventIdOf(facts.bookingId),
    // A booking deleted in Google and written again comes back (its id is kept, cancelled).
    status: 'confirmed' as const,
    summary: client === '' ? service : `${service} · ${client}`,
    description: 'Booked in Pepper. Change it in Pepper: changes made here aren’t kept.',
    start: { dateTime: facts.startsAt.toISOString() },
    end: { dateTime: facts.endsAt.toISOString() },
    visibility: 'private' as const,
    transparency: 'opaque' as const,
    extendedProperties: { private: { pepperBookingId: facts.bookingId.toLowerCase() } },
  };
}
export type CalendarEventBody = ReturnType<typeof calendarEventBodyOf>;

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

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

/** calendars.insert's answer: Pepper keeps only the new calendar's id. */
export const GoogleCalendarResourceSchema = z.object({
  id: z.string().min(1).max(1024),
});

/** events.insert/patch's answer: the event's id (Pepper's own) and its status. */
export const GoogleEventResourceSchema = z.object({
  id: z.string().min(1).max(1024),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
});

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
  /** Google gave the "Pepper bookings" permission: bookings are written there (S71, AC-X-167). */
  writesBookings: z.boolean(),
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

/**
 * `GET /v1/calendar/bookings/:id` (S71 top-up, AC-X-173): whether a booking is in Google
 * Calendar: `written`, `pending` (waiting for the worker or a retry), `waiting` (until its
 * staff member reconnects their calendar), or `none` (their calendar doesn't take bookings).
 */
export const BookingCalendarStateSchema = z.object({
  state: z.enum(['written', 'pending', 'waiting', 'none']),
});
export type BookingCalendarState = z.infer<typeof BookingCalendarStateSchema>;

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
