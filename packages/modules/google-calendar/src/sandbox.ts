import { randomBytes } from 'node:crypto';
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_EVENTS_SCOPE,
  type CalendarEventBody,
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

// The sandbox (S70, ADR-0069 §1): Google's flow without Google, for tests and the S70.2
// journeys. Nothing leaves the machine. Its consent page is the app's own return page, with a
// code the sandbox understands: `sandbox-ok` connects; `sandbox-expiring` connects with a refresh
// token Google would refuse at the next read (the testing-mode 7 days, in one step);
// `sandbox-expired` (S70.2) does too with an access token already run out, so the connect's own
// first read finds it needs reconnecting (the browser journeys' Home card). Every
// connected calendar is busy one hour a day, 17:00–18:00 UTC (noon in New York in winter).
// `sandbox-busy-only` (S71) connects as a member who unticked the bookings permission. Calendars
// and events Pepper writes (S71) are kept in memory, per provider, as Google keeps them: an id
// is taken once, and a deleted event keeps its id (cancelled) until it is written again.

export const SANDBOX_ACCOUNT_EMAIL = 'calendar@sandbox.test';
export const SANDBOX_BUSY_HOUR_UTC = 17;

const HOUR_MS = 3_600_000;

const SANDBOX_CODES = new Set([
  'sandbox-ok',
  'sandbox-expiring',
  'sandbox-expired',
  'sandbox-busy-only',
]);

/** An event as the sandbox keeps it. */
export interface SandboxEvent {
  body: CalendarEventBody;
  status: 'confirmed' | 'cancelled';
}
const DAY_MS = 24 * HOUR_MS;

export class SandboxCalendarProvider implements CalendarProvider {
  readonly name = 'sandbox' as const;
  private readonly revoked = new Set<string>();
  private calendarCount = 0;
  /** Calendars Pepper made, by id: their events by id. Tests read it. */
  readonly calendars = new Map<string, Map<string, SandboxEvent>>();

  constructor(
    private readonly redirectUri: string,
    private readonly now: () => number = Date.now,
  ) {}

  consentUrl(input: ConsentUrlInput): string {
    const url = new URL(this.redirectUri);
    url.searchParams.set('code', 'sandbox-ok');
    url.searchParams.set('state', input.state);
    url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
    return url.toString();
  }

  exchangeCode(input: ExchangeCodeInput): Promise<GrantedTokens> {
    if (!SANDBOX_CODES.has(input.code)) {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    if (input.codeVerifier.length < 43) {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    const kind =
      input.code === 'sandbox-ok' || input.code === 'sandbox-busy-only' ? 'ok' : 'expiring';
    return Promise.resolve({
      refreshToken: `sbx-r-${kind}-${randomBytes(12).toString('hex')}`,
      accessToken: `sbx-a-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(this.now() + (input.code === 'sandbox-expired' ? 0 : HOUR_MS)),
      scopes:
        input.code === 'sandbox-busy-only'
          ? GOOGLE_CALENDAR_SCOPES.filter((scope) => scope !== GOOGLE_EVENTS_SCOPE)
          : [...GOOGLE_CALENDAR_SCOPES],
      accountEmail: SANDBOX_ACCOUNT_EMAIL,
    });
  }

  refresh(refreshToken: string): Promise<AccessToken> {
    if (!refreshToken.startsWith('sbx-r-ok-') || this.revoked.has(refreshToken)) {
      return Promise.reject(new CalendarProviderError('invalid_grant', 400));
    }
    return Promise.resolve({
      accessToken: `sbx-a-${randomBytes(12).toString('hex')}`,
      expiresAt: new Date(this.now() + HOUR_MS),
    });
  }

  freeBusy(input: FreeBusyInput): Promise<{ start: string; end: string }[]> {
    if (!input.accessToken.startsWith('sbx-a-')) {
      return Promise.reject(new CalendarProviderError('unauthorized', 401));
    }
    const busy: { start: string; end: string }[] = [];
    const firstDay = Math.floor(input.from.getTime() / DAY_MS) * DAY_MS;
    for (let day = firstDay; day < input.to.getTime(); day += DAY_MS) {
      const start = day + SANDBOX_BUSY_HOUR_UTC * HOUR_MS;
      const end = start + HOUR_MS;
      if (end > input.from.getTime() && start < input.to.getTime()) {
        busy.push({ start: new Date(start).toISOString(), end: new Date(end).toISOString() });
      }
    }
    return Promise.resolve(busy);
  }

  revoke(token: string): Promise<void> {
    this.revoked.add(token);
    return Promise.resolve();
  }

  createCalendar(input: CreateCalendarInput): Promise<{ id: string }> {
    return this.authorized(input.accessToken, () => {
      this.calendarCount += 1;
      const id = `sandbox-calendar-${String(this.calendarCount)}@group.calendar.sandbox`;
      this.calendars.set(id, new Map());
      return { id };
    });
  }

  deleteCalendar(input: { accessToken: string; calendarId: string }): Promise<void> {
    return this.authorized(input.accessToken, () => {
      this.calendars.delete(input.calendarId);
    });
  }

  insertEvent(input: EventInput): Promise<'created' | 'exists'> {
    return this.authorized(input.accessToken, () => {
      const events = this.calendarOf(input.calendarId);
      if (events.has(input.event.id)) return 'exists' as const;
      events.set(input.event.id, { body: input.event, status: 'confirmed' });
      return 'created' as const;
    });
  }

  patchEvent(input: EventInput): Promise<'updated' | 'missing'> {
    return this.authorized(input.accessToken, () => {
      const events = this.calendars.get(input.calendarId);
      if (events?.has(input.event.id) !== true) return 'missing' as const;
      events.set(input.event.id, { body: input.event, status: input.event.status });
      return 'updated' as const;
    });
  }

  deleteEvent(input: EventRef): Promise<void> {
    return this.authorized(input.accessToken, () => {
      const event = this.calendars.get(input.calendarId)?.get(input.eventId);
      if (event !== undefined) event.status = 'cancelled';
    });
  }

  /** The events of a calendar that aren't cancelled (tests). */
  liveEvents(calendarId: string): CalendarEventBody[] {
    return [...(this.calendars.get(calendarId)?.values() ?? [])]
      .filter((event) => event.status === 'confirmed')
      .map((event) => event.body);
  }

  private calendarOf(id: string): Map<string, SandboxEvent> {
    const events = this.calendars.get(id);
    if (events === undefined) throw new CalendarProviderError('not_found', 404);
    return events;
  }

  private authorized<T>(accessToken: string, run: () => T): Promise<T> {
    if (!accessToken.startsWith('sbx-a-')) {
      return Promise.reject(new CalendarProviderError('unauthorized', 401));
    }
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
