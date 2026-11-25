import type {
  CalendarConnection,
  CalendarConnectionAnswer,
  TeamCalendarConnection,
} from '@pepper/contracts';
import type { BadgeTone } from '@pepper/ui';

// The words of Google Calendar on screen (S70.2, AC-X-160…164, ADR-0069): More → Calendar,
// Google's return page, the Home card and the Team list. The api decides the status; these only
// say it. Nobody sees a token, a code or an error id.

export const CALENDAR_GOOGLE_PATH = '/v1/calendar/google';
export const CALENDAR_CONNECT_PATH = '/v1/calendar/google/connect';
export const CALENDAR_CALLBACK_PATH = '/v1/calendar/google/callback';
export const CALENDAR_CONNECTIONS_PATH = '/v1/calendar/connections';

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
  action: 'Connect Google Calendar' | 'Reconnect Google Calendar' | null;
  /** Whether Disconnect is offered. */
  disconnect: boolean;
}

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
            'Pepper sees only when you’re busy, never what the event is.',
          ],
          action: 'Connect Google Calendar',
          disconnect: false,
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
        };
  }
  if (connection.status === 'needs_reconnect') {
    const kept =
      connection.syncedAt === null
        ? 'Pepper keeps the busy times it has'
        : `Pepper keeps the busy times it read ${readAgo(connection.syncedAt, timeZone, now)}`;
    return {
      badge: 'Needs reconnecting',
      tone: 'warn',
      lines: [
        `Google stopped letting Pepper read ${connection.accountEmail}.`,
        `${kept} until you reconnect, so nothing gets booked over them.`,
      ],
      action: 'Reconnect Google Calendar',
      disconnect: true,
    };
  }
  return {
    badge: 'Connected',
    tone: 'ok',
    lines: [
      `${connection.accountEmail} · ${capitalized(readLine(connection, timeZone, now))}`,
      'Pepper reads when you’re busy every 5 minutes and won’t book clients over it.',
    ],
    action: null,
    disconnect: true,
  };
}

/** The More row's line under "Google Calendar". */
export function calendarSummary(
  answer: CalendarConnectionAnswer,
  timeZone: string,
  now: Date = new Date(),
): string {
  const { connection } = answer;
  if (connection === null) {
    return answer.canConnect ? 'Keep your own plans from being booked over' : 'Not linked to you';
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
  /** The member said no at Google, or Google sent an error. */
  | { kind: 'declined' }
  /** Opened with nothing usable (a reload after the address was cleaned, a broken link). */
  | { kind: 'none' };

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Google's return: `?code&state` once the member agrees, `?error=access_denied` if not. */
export function googleArrival(
  params: Record<string, string | string[] | undefined>,
): GoogleArrival {
  const code = one(params['code']);
  const state = one(params['state']);
  if (one(params['error']) !== undefined) return { kind: 'declined' };
  if (code !== undefined && code.length > 0 && state !== undefined && state.length > 0) {
    return { kind: 'code', code, state };
  }
  return { kind: 'none' };
}

/** Whether Home shows "Reconnect your Google Calendar" (AC-X-163): the member's own only. */
export function needsReconnect(answer: CalendarConnectionAnswer | null): boolean {
  return answer?.connection?.status === 'needs_reconnect';
}
