import { z } from 'zod';
import {
  CalendarConnectCompleteSchema,
  type BookingCalendarState,
  type CalendarConnection,
  type CalendarConnectionAnswer,
  type TeamCalendarConnection,
} from '@pepper/contracts';
import type { BadgeTone } from '@pepper/ui';
import { errorCodeOf, messageFor } from './client-api';

// The words of Google Calendar on screen (S70.2, AC-X-160…164, ADR-0069): More → Calendar,
// Google's return page, the Home card and the Team list. The api decides the status; these only
// say it. Nobody sees a token, a code or an error id.

export const CALENDAR_GOOGLE_PATH = '/v1/calendar/google';
export const CALENDAR_CONNECT_PATH = '/v1/calendar/google/connect';
export const CALENDAR_CALLBACK_PATH = '/v1/calendar/google/callback';
export const CALENDAR_CONNECTIONS_PATH = '/v1/calendar/connections';

/** A booking's place in Google Calendar (S71 top-up, AC-X-173). */
export function bookingCalendarPath(bookingId: string): string {
  return `/v1/calendar/bookings/${encodeURIComponent(bookingId)}`;
}

/**
 * The booking sheet's Google Calendar line (AC-X-173): said once the booking is written there,
 * or while it is on its way; nothing when its staff member's calendar doesn't take bookings.
 */
export function bookingCalendarLine(state: BookingCalendarState['state'] | null): string | null {
  if (state === 'written') return 'Also in Google Calendar';
  if (state === 'pending') return 'Adding to Google Calendar…';
  if (state === 'waiting') return 'Waiting for Google Calendar to be reconnected';
  return null;
}

/**
 * The sheet's second line (S71.2 top-up, AC-X-180): Pepper put the booking back over a change
 * made in Google lately, so staff know why their edit there didn't stick.
 */
export function keptOverGoogleLine(answer: BookingCalendarState | null): string | null {
  return answer?.state === 'written' && answer.keptOverGoogle === true
    ? 'Changed in Google, kept as booked in Pepper'
    : null;
}

/** What More → Calendar says once disconnected (AC-X-172): what went with it. */
export function disconnectedNote(writesBookings: boolean): string {
  return writesBookings
    ? `Disconnected. Your Google busy times no longer block bookings, and Google was asked to delete ${BOOKINGS_CALENDAR}.`
    : 'Disconnected. Your Google busy times no longer block bookings.';
}

/** Where Pepper writes bookings in the member's Google account (S71, D-2). */
const BOOKINGS_CALENDAR = '“Pepper bookings”';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * When the busy times were last read, as a person says it: "just now", "3 min ago", "2 h ago",
 * then the day in the business's time zone ("Nov 24").
 */
export function readAgo(syncedAt: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(syncedAt);
  const gone = Math.max(0, now.getTime() - at.getTime());
  if (gone < MINUTE) return 'just now';
  if (gone < HOUR) return `${String(Math.floor(gone / MINUTE))} min ago`;
  if (gone < 24 * HOUR) return `${String(Math.floor(gone / HOUR))} h ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(at);
}

/** "read 3 min ago", or "not read yet". */
function readLine(connection: Pick<CalendarConnection, 'syncedAt'>, timeZone: string, now: Date) {
  return connection.syncedAt === null
    ? 'not read yet'
    : `read ${readAgo(connection.syncedAt, timeZone, now)}`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** More → Calendar in words: the badge, the lines under it, and the one main action. */
export interface CalendarWords {
  badge: string;
  tone: BadgeTone;
  lines: string[];
  /** The main action, or `null` when there is none (connected, or nothing to connect for). */
  action: 'Connect Google Calendar' | 'Reconnect Google Calendar' | 'Add bookings to Google' | null;
  /** Whether Disconnect is offered. */
  disconnect: boolean;
  /** What the Disconnect confirm says will happen (AC-X-172). */
  disconnectNote: string;
}

const DISCONNECT_BUSY =
  'Your Google busy times will stop blocking bookings, and Google will be asked to forget Pepper. You can connect again any time.';
const DISCONNECT_BOOKINGS = `Your Google busy times will stop blocking bookings, Google will be asked to delete the ${BOOKINGS_CALENDAR} calendar and to forget Pepper. You can connect again any time.`;

export function calendarWords(
  answer: CalendarConnectionAnswer,
  timeZone: string,
  now: Date = new Date(),
): CalendarWords {
  const { connection } = answer;
  if (connection === null) {
    return answer.canConnect
      ? {
          badge: 'Not connected',
          tone: 'neutral',
          lines: [
            'Connect your Google Calendar and Pepper won’t book clients over your own plans.',
            `Pepper sees only when you’re busy, never what the event is, and adds your bookings to a calendar of its own, ${BOOKINGS_CALENDAR}.`,
          ],
          action: 'Connect Google Calendar',
          disconnect: false,
          disconnectNote: DISCONNECT_BUSY,
        }
      : {
          badge: 'Not linked',
          tone: 'neutral',
          lines: [
            'Your login isn’t linked to a staff member, so there’s no calendar of yours to connect.',
            'The owner can link it on Team.',
          ],
          action: null,
          disconnect: false,
          disconnectNote: DISCONNECT_BUSY,
        };
  }
  const disconnectNote = connection.writesBookings ? DISCONNECT_BOOKINGS : DISCONNECT_BUSY;
  if (connection.status === 'needs_reconnect') {
    return {
      badge: 'Needs reconnecting',
      tone: 'warn',
      lines: [
        `Google stopped letting Pepper read ${connection.accountEmail}.`,
        'Until you reconnect, Pepper keeps the busy times it last read, so nothing gets booked over them.',
        ...(connection.writesBookings
          ? ['New and changed bookings reach Google Calendar once you reconnect.']
          : []),
      ],
      action: 'Reconnect Google Calendar',
      disconnect: true,
      disconnectNote,
    };
  }
  const read = [
    `${connection.accountEmail} · ${capitalized(readLine(connection, timeZone, now))}`,
    'Pepper checks your busy times every 5 minutes and won’t book clients over them.',
  ];
  return connection.writesBookings
    ? {
        badge: 'Connected',
        tone: 'ok',
        lines: [...read, `Your bookings are added to ${BOOKINGS_CALENDAR} in Google Calendar.`],
        action: null,
        disconnect: true,
        disconnectNote,
      }
    : {
        badge: 'Connected',
        tone: 'ok',
        lines: [
          ...read,
          'Your bookings aren’t added to Google Calendar: Google wasn’t given that permission.',
        ],
        action: 'Add bookings to Google',
        disconnect: true,
        disconnectNote,
      };
}

/** The More row's line for a member with nothing connected. */
export const CONNECT_PITCH = 'Keep your own plans from being booked over';

/** The More row's line when the calendar can't be read just now. */
export const CALENDAR_UNREAD = 'Couldn’t load it just now';

/** The More row's line under "Google Calendar". */
export function calendarSummary(
  answer: CalendarConnectionAnswer,
  timeZone: string,
  now: Date = new Date(),
): string {
  const { connection } = answer;
  if (connection === null) {
    return answer.canConnect ? CONNECT_PITCH : 'Not linked to you';
  }
  return connection.status === 'needs_reconnect'
    ? 'Needs reconnecting'
    : `Connected · ${readLine(connection, timeZone, now)}`;
}

/**
 * A staff member's calendar on the Team list (AC-X-164): "Google Calendar · read 3 min ago",
 * "Google Calendar · not read yet", "Needs reconnecting", or "No calendar connected".
 */
export function teamCalendarLine(
  connection: TeamCalendarConnection | undefined,
  timeZone: string,
  now: Date = new Date(),
): { text: string; tone: 'quiet' | 'warn' } {
  if (connection === undefined) return { text: 'No calendar connected', tone: 'quiet' };
  if (connection.status === 'needs_reconnect') return { text: 'Needs reconnecting', tone: 'warn' };
  return { text: `Google Calendar · ${readLine(connection, timeZone, now)}`, tone: 'quiet' };
}

/** What Google's return page was given (AC-X-161). */
export type GoogleArrival =
  | { kind: 'code'; code: string; state: string }
  /** The member said no at Google (`access_denied`). */
  | { kind: 'declined' }
  /** Google sent another error (an admin's policy, a scope it refused, Google failing). */
  | { kind: 'failed' }
  /** Opened with nothing usable (a reload after the address was cleaned, a broken link). */
  | { kind: 'none' };

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Google's return: `?code&state` once the member agrees, `?error=access_denied` if not, another
 * `error` when Google couldn't finish. The code and state are checked like the api checks them
 * (`CalendarConnectCompleteSchema`) before anything is sent.
 */
export function googleArrival(
  params: Record<string, string | string[] | undefined>,
): GoogleArrival {
  const error = one(params['error']);
  if (error !== undefined)
    return error === 'access_denied' ? { kind: 'declined' } : { kind: 'failed' };
  const parsed = CalendarConnectCompleteSchema.safeParse({
    code: one(params['code']),
    state: one(params['state']),
  });
  return parsed.success ? { kind: 'code', ...parsed.data } : { kind: 'none' };
}

/**
 * How Google's return ended (AC-X-161), carried to More → Calendar as `?google=`: connected,
 * the member said no, Google failed, or the api's refusal.
 */
export const GoogleOutcomeSchema = z.enum([
  'connected',
  'declined',
  'failed',
  'calendar_connect_invalid',
  'calendar_scope_missing',
  'calendar_unavailable',
  'calendar_not_linked',
  'calendar_off',
]);
export type GoogleOutcome = z.infer<typeof GoogleOutcomeSchema>;

/** The `?google=` of More → Calendar, or `null` for none or anything else. */
export function googleOutcomeOf(value: string | string[] | undefined): GoogleOutcome | null {
  const parsed = GoogleOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** What More → Calendar says at the top for how Google's return ended. */
export function outcomeNote(outcome: GoogleOutcome | null): {
  tone: 'ok' | 'error';
  text: string;
} | null {
  switch (outcome) {
    case null:
      return null;
    case 'connected':
      return { tone: 'ok', text: 'Connected. Pepper won’t book clients over your busy times.' };
    case 'declined':
      return { tone: 'error', text: 'Nothing was connected: Google says you didn’t allow it.' };
    case 'failed':
      return {
        tone: 'error',
        text: 'Google couldn’t finish connecting your calendar. Try again in a minute. If your Google account is a work one, its admin may need to allow Pepper.',
      };
    case 'calendar_connect_invalid':
    case 'calendar_scope_missing':
    case 'calendar_unavailable':
    case 'calendar_not_linked':
    case 'calendar_off':
      return { tone: 'error', text: messageFor(400, { code: outcome }) };
  }
}

/** How the web server calls the api for the member (their cookie, the app's origin). */
export interface ReturnCall {
  apiBaseUrl: string;
  /** Pepper's public origin: the api refuses a call from any other. */
  origin: string;
  cookie: string | null;
  forwardedFor: string | null;
  fetch?: typeof globalThis.fetch;
}

/**
 * Google's return (S70.2, AC-X-161, ADR-0069): finishes the connect on the server, once, with
 * what Google sent, and says how it ended. The code never reaches the page's script, and the
 * return address is never an entry the browser's Back can bring back.
 */
export async function finishGoogleReturn(
  params: Record<string, string | string[] | undefined>,
  call: ReturnCall,
): Promise<GoogleOutcome | null> {
  const arrival = googleArrival(params);
  if (arrival.kind === 'none') return null;
  if (arrival.kind !== 'code') return arrival.kind;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: call.origin,
  };
  if (call.cookie !== null) headers['cookie'] = call.cookie;
  if (call.forwardedFor !== null) headers['x-forwarded-for'] = call.forwardedFor;
  let response: Response;
  try {
    response = await (call.fetch ?? globalThis.fetch)(
      new URL(CALENDAR_CALLBACK_PATH, call.apiBaseUrl),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ code: arrival.code, state: arrival.state }),
        cache: 'no-store',
        // The api exchanges the code and reads the calendar once before it answers.
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return 'calendar_unavailable';
  }
  if (response.status === 200) return 'connected';
  const code = errorCodeOf(await response.json().catch(() => undefined));
  return googleOutcomeOf(code) ?? 'failed';
}

/** Whether Home shows "Reconnect your Google Calendar" (AC-X-163): the member's own only. */
export function needsReconnect(answer: CalendarConnectionAnswer | null): boolean {
  return answer?.connection?.status === 'needs_reconnect';
}
