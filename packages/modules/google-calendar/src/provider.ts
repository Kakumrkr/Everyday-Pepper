import type {
  CalendarEventBody,
  CalendarProvider as CalendarProviderName,
  CalendarSyncError,
} from '@pepper/contracts';

// The calendar port (S70, ADR-0069 §1): what the services ask of Google. `GoogleCalendarProvider`
// calls Google; `SandboxCalendarProvider` never leaves the machine. Callers never hold a database
// transaction open across a call, and never log what goes in or comes out.

export interface ConsentUrlInput {
  /** 32 random bytes, base64url: Google gives it back unchanged. */
  state: string;
  /** The PKCE challenge: base64url(SHA-256(verifier)). */
  codeChallenge: string;
  /** Pre-fills Google's account chooser (a reconnect). */
  loginHint?: string | undefined;
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
}

/** Tokens and who they belong to, after the member said yes. */
export interface GrantedTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: Date;
  /** The scopes granted, as Google lists them. */
  scopes: readonly string[];
  /** The Google account's email, as Google verified it. */
  accountEmail: string;
}

export interface AccessToken {
  accessToken: string;
  expiresAt: Date;
}

export interface FreeBusyInput {
  accessToken: string;
  from: Date;
  to: Date;
}

export interface CreateCalendarInput {
  accessToken: string;
  /** "Pepper bookings". */
  name: string;
  /** The business's IANA time zone, for how Google shows the calendar's events. */
  timeZone: string;
}

export interface EventInput {
  accessToken: string;
  calendarId: string;
  event: CalendarEventBody;
}

export interface EventRef {
  accessToken: string;
  calendarId: string;
  eventId: string;
}

export interface CalendarProvider {
  readonly name: CalendarProviderName;
  /** Google's consent page for this connect. */
  consentUrl(input: ConsentUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<GrantedTokens>;
  refresh(refreshToken: string): Promise<AccessToken>;
  /** The primary calendar's busy times overlapping [from, to), as Google gives them. */
  freeBusy(input: FreeBusyInput): Promise<{ start: string; end: string }[]>;
  /** Asks Google to forget the grant; a token already gone is not an error. */
  revoke(token: string): Promise<void>;
  /** Makes a calendar in the account (S71: "Pepper bookings"); answers its id. */
  createCalendar(input: CreateCalendarInput): Promise<{ id: string }>;
  /** Deletes a calendar Pepper made; one already gone is not an error. */
  deleteCalendar(input: { accessToken: string; calendarId: string }): Promise<void>;
  /**
   * Adds the event with its own id. `exists`: the calendar has an event with that id already
   * (written before, or deleted and kept by Google): nothing was changed. A missing calendar is
   * `not_found`.
   */
  insertEvent(input: EventInput): Promise<'created' | 'exists'>;
  /** Changes the event to `event` (status included). `missing`: no event with that id. */
  patchEvent(input: EventInput): Promise<'updated' | 'missing'>;
  /** Removes the event; one already gone, or its calendar, is not an error. */
  deleteEvent(input: EventRef): Promise<void>;
}

/**
 * A call to Google that didn't give what was asked: `code` says why (`invalid_grant` the refresh
 * token is expired or revoked; `unauthorized` the access token; `rate_limited`; `unavailable` a
 * timeout, a network error or a 5xx; `not_found`; `bad_response` an answer of the wrong shape).
 * The message never holds a token or Google's text.
 */
export class CalendarProviderError extends Error {
  override readonly name = 'CalendarProviderError';

  constructor(
    readonly code: CalendarSyncError,
    readonly status: number | null = null,
  ) {
    super(`Google Calendar: ${code}${status === null ? '' : ` (${String(status)})`}`);
  }
}
