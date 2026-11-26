import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleApiErrorSchema,
  GoogleCalendarResourceSchema,
  GoogleEventResourceSchema,
  GoogleFreeBusyResponseSchema,
  GoogleIdTokenClaimsSchema,
  GoogleRateLimitReasonSchema,
  GoogleTokenErrorSchema,
  GoogleTokenResponseSchema,
  type CalendarSyncError,
} from '@pepper/contracts';
import {
  CalendarProviderError,
  type AccessToken,
  type CalendarProvider,
  type ConsentUrlInput,
  type CreateCalendarInput,
  type EventInput,
  type EventRef,
  type ExchangeCodeInput,
  type FreeBusyInput,
  type GrantedTokens,
} from './provider.js';

// Google's OAuth 2.0 web-server flow, Calendar's freeBusy (S70, ADR-0069 §1–3) and, from S71, a
// calendar Pepper makes and its events (§10), coded from
// developers.google.com (read 2026-11-25): `accounts.google.com/o/oauth2/v2/auth`,
// `oauth2.googleapis.com/token` and `/revoke`, `www.googleapis.com/calendar/v3/freeBusy`; and
// (read 2026-11-26) `calendars` insert/delete, `calendars/{id}/events` insert/patch/delete. Form
// bodies to the OAuth endpoints, JSON to Calendar, a timeout on every call, every answer parsed.
// No token, code or Google text ever goes into an error or a log.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_FREEBUSY_URL = 'https://www.googleapis.com/calendar/v3/freeBusy';
/** calendars.insert (S71); a calendar and its events are under it, by id. */
export const GOOGLE_CALENDARS_URL = 'https://www.googleapis.com/calendar/v3/calendars';

const TIMEOUT_MS = 15_000;

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
  /** The app's return page: registered with Google exactly as written here. */
  redirectUri: string;
  /** Tests give their own; production uses the global `fetch`. */
  fetch?: typeof fetch;
  /** Now, for the ID token's expiry and the access token's (tests give their own). */
  now?: () => number;
}

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  consentUrl(input: ConsentUrlInput): string {
    const url = new URL(GOOGLE_AUTH_URL);
    const params: Record<string, string> = {
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
      access_type: 'offline',
      // A new refresh token each time, so a reconnect after an expiry gets a working one.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      ...(input.loginHint !== undefined && { login_hint: input.loginHint }),
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<GrantedTokens> {
    const answer = await this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: this.options.redirectUri,
    });
    if (answer.refresh_token === undefined || answer.id_token === undefined) {
      throw new CalendarProviderError('bad_response');
    }
    return {
      refreshToken: answer.refresh_token,
      accessToken: answer.access_token,
      expiresAt: new Date(this.now() + answer.expires_in * 1000),
      scopes: answer.scope.split(' ').filter((s) => s !== ''),
      accountEmail: this.emailOf(answer.id_token),
    };
  }

  async refresh(refreshToken: string): Promise<AccessToken> {
    const answer = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return {
      accessToken: answer.access_token,
      expiresAt: new Date(this.now() + answer.expires_in * 1000),
    };
  }

  async freeBusy(input: FreeBusyInput): Promise<{ start: string; end: string }[]> {
    const response = await this.call(GOOGLE_FREEBUSY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        timeMin: input.from.toISOString(),
        timeMax: input.to.toISOString(),
        items: [{ id: 'primary' }],
      }),
    });
    const body = await jsonOf(response);
    if (!response.ok)
      throw new CalendarProviderError(apiErrorCode(response.status, body), response.status);
    const parsed = GoogleFreeBusyResponseSchema.safeParse(body);
    const primary = parsed.success ? parsed.data.calendars['primary'] : undefined;
    if (primary === undefined) throw new CalendarProviderError('bad_response');
    if (primary.errors !== undefined && primary.errors.length > 0) {
      throw new CalendarProviderError(
        primary.errors.some((e) => e.reason === 'notFound') ? 'not_found' : 'unavailable',
      );
    }
    return primary.busy;
  }

  async revoke(token: string): Promise<void> {
    const response = await this.call(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
    // 400 `invalid_token`: already revoked or expired, which is what was asked.
    if (response.ok || response.status === 400) return;
    throw new CalendarProviderError(
      response.status >= 500 ? 'unavailable' : 'bad_response',
      response.status,
    );
  }

  async createCalendar(input: CreateCalendarInput): Promise<{ id: string }> {
    const response = await this.call(GOOGLE_CALENDARS_URL, {
      method: 'POST',
      headers: this.json(input.accessToken),
      body: JSON.stringify({ summary: input.name, timeZone: input.timeZone }),
    });
    const body = await jsonOf(response);
    if (!response.ok)
      throw new CalendarProviderError(apiErrorCode(response.status, body), response.status);
    const parsed = GoogleCalendarResourceSchema.safeParse(body);
    if (!parsed.success) throw new CalendarProviderError('bad_response');
    return { id: parsed.data.id };
  }

  async deleteCalendar(input: { accessToken: string; calendarId: string }): Promise<void> {
    const response = await this.call(calendarUrl(input.calendarId), {
      method: 'DELETE',
      headers: this.json(input.accessToken),
    });
    if (response.ok || response.status === 404 || response.status === 410) return;
    throw new CalendarProviderError(
      apiErrorCode(response.status, await jsonOf(response)),
      response.status,
    );
  }

  async insertEvent(input: EventInput): Promise<'created' | 'exists'> {
    const response = await this.call(`${calendarUrl(input.calendarId)}/events`, {
      method: 'POST',
      headers: this.json(input.accessToken),
      body: JSON.stringify(input.event),
    });
    const body = await jsonOf(response);
    // 409 `duplicate`: "The requested identifier already exists."
    if (response.status === 409) return 'exists';
    if (!response.ok)
      throw new CalendarProviderError(apiErrorCode(response.status, body), response.status);
    this.sameEvent(body, input.event.id);
    return 'created';
  }

  async patchEvent(input: EventInput): Promise<'updated' | 'missing'> {
    const response = await this.call(eventUrl(input.calendarId, input.event.id), {
      method: 'PATCH',
      headers: this.json(input.accessToken),
      body: JSON.stringify(input.event),
    });
    const body = await jsonOf(response);
    if (response.status === 404 || response.status === 410) return 'missing';
    if (!response.ok)
      throw new CalendarProviderError(apiErrorCode(response.status, body), response.status);
    this.sameEvent(body, input.event.id);
    return 'updated';
  }

  async deleteEvent(input: EventRef): Promise<void> {
    const response = await this.call(eventUrl(input.calendarId, input.eventId), {
      method: 'DELETE',
      headers: this.json(input.accessToken),
    });
    // 410: deleted already; 404: no such event, or its calendar is gone. Both are what was asked.
    if (response.ok || response.status === 404 || response.status === 410) return;
    throw new CalendarProviderError(
      apiErrorCode(response.status, await jsonOf(response)),
      response.status,
    );
  }

  private json(accessToken: string): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  }

  /** Google's answer names the event Pepper wrote, or it isn't the answer it should be. */
  private sameEvent(body: unknown, id: string): void {
    const parsed = GoogleEventResourceSchema.safeParse(body);
    if (!parsed.success || parsed.data.id !== id) throw new CalendarProviderError('bad_response');
  }

  private async token(fields: Record<string, string>) {
    const response = await this.call(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // The client in a Basic header (RFC 6749 §2.3.1, which Google accepts), never in the
        // body: the secret stays out of anything that logs or echoes a form (S70.2).
        Authorization: `Basic ${Buffer.from(
          `${formEncoded(this.options.clientId)}:${formEncoded(this.options.clientSecret)}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams(fields).toString(),
    });
    const body = await jsonOf(response);
    if (!response.ok) {
      const error = GoogleTokenErrorSchema.safeParse(body);
      if (error.success && error.data.error === 'invalid_grant') {
        throw new CalendarProviderError('invalid_grant', response.status);
      }
      throw new CalendarProviderError(statusCode(response.status), response.status);
    }
    const parsed = GoogleTokenResponseSchema.safeParse(body);
    if (!parsed.success) throw new CalendarProviderError('bad_response');
    return parsed.data;
  }

  /**
   * The account's email from the ID token Google's token endpoint just gave over HTTPS with the
   * client secret: its signature needn't be checked (Google's OpenID Connect guide), its issuer,
   * audience, expiry and verified email are.
   */
  private emailOf(idToken: string): string {
    const [, payload] = idToken.split('.');
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
    } catch {
      throw new CalendarProviderError('bad_response');
    }
    const parsed = GoogleIdTokenClaimsSchema.safeParse(claims);
    if (
      !parsed.success ||
      parsed.data.aud !== this.options.clientId ||
      parsed.data.exp * 1000 <= this.now() ||
      parsed.data.email_verified === false ||
      parsed.data.email_verified === 'false'
    ) {
      throw new CalendarProviderError('bad_response');
    }
    return parsed.data.email.toLowerCase();
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      // A timeout or the network: no answer to read.
      throw new CalendarProviderError('unavailable');
    }
  }
}

function calendarUrl(calendarId: string): string {
  return `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(calendarId)}`;
}

function eventUrl(calendarId: string, eventId: string): string {
  return `${calendarUrl(calendarId)}/events/${encodeURIComponent(eventId)}`;
}

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function statusCode(status: number): CalendarSyncError {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'unavailable';
  return 'bad_response';
}

/** Calendar's 403 with a `usageLimits` reason is a rate limit, like its 429. */
function apiErrorCode(status: number, body: unknown): CalendarSyncError {
  if (status === 403) {
    const parsed = GoogleApiErrorSchema.safeParse(body);
    const reasons = parsed.success ? (parsed.data.error.errors ?? []) : [];
    if (reasons.some((e) => GoogleRateLimitReasonSchema.safeParse(e.reason).success))
      return 'rate_limited';
    // Any other 403 on Calendar: the grant lacks the permission (S71: a calendar not Pepper's,
    // or a scope unticked); trying again with the same grant won't help.
    return 'forbidden';
  }
  return statusCode(status);
}

/** One value as `application/x-www-form-urlencoded` encodes it (RFC 6749 §2.3.1, Appendix B). */
export function formEncoded(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}
