import { randomBytes, randomUUID } from 'node:crypto';
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_EVENTS_SCOPE,
  calendarEventBodyOf,
  type CalendarEventBody,
  type GoogleListedEvent,
} from '@pepper/contracts';
import {
  CalendarProviderError,
  type AccessToken,
  type CalendarProvider,
  type ConsentUrlInput,
  type CreateCalendarInput,
  type EventInput,
  type EventPage,
  type EventRef,
  type ListEventsInput,
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
// From S71.2 it lists them as Google does: every change gets the next number, a sync token
// names the number read up to, pages hold `pageSize` events, and `expireSyncTokens` makes every
// token given so far answer 410. `changeInGoogle` and `addOwnEvent` are what a member does in
// Google (tests).

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
  /** The change number it was last changed at. */
  changed: number;
  /** What a member changed in Google over Pepper's body, until Pepper writes it again. */
  inGoogle?: Partial<Pick<GoogleListedEvent, 'summary' | 'start' | 'end'>>;
}
const DAY_MS = 24 * HOUR_MS;

export class SandboxCalendarProvider implements CalendarProvider {
  readonly name = 'sandbox' as const;
  private readonly revoked = new Set<string>();
  private calendarCount = 0;
  private changeCount = 0;
  /** Tokens name the epoch they were given in; `expireSyncTokens` starts a new one. */
  private epoch = 0;
  /** Events per page of `listEvents`. */
  pageSize = 250;
  /** Calls to `listEvents` (tests). */
  listCalls = 0;
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
      events.set(input.event.id, { body: input.event, status: 'confirmed', changed: this.next() });
      return 'created' as const;
    });
  }

  patchEvent(input: EventInput): Promise<'updated' | 'missing'> {
    return this.authorized(input.accessToken, () => {
      const events = this.calendars.get(input.calendarId);
      if (events?.has(input.event.id) !== true) return 'missing' as const;
      events.set(input.event.id, {
        body: input.event,
        status: input.event.status,
        changed: this.next(),
      });
      return 'updated' as const;
    });
  }

  deleteEvent(input: EventRef): Promise<void> {
    return this.authorized(input.accessToken, () => {
      const event = this.calendars.get(input.calendarId)?.get(input.eventId);
      if (event !== undefined && event.status !== 'cancelled') {
        event.status = 'cancelled';
        event.changed = this.next();
      }
    });
  }

  listEvents(input: ListEventsInput): Promise<EventPage | 'sync_expired'> {
    return this.authorized(input.accessToken, () => {
      this.listCalls += 1;
      const events = this.calendarOf(input.calendarId);
      const sync =
        input.syncToken === null ? null : /^sbx-sync-(\d+)-(\d+)$/u.exec(input.syncToken);
      const page =
        input.pageToken === null ? null : /^sbx-page-(\d+)-(\d+)-(\d+)$/u.exec(input.pageToken);
      const epoch = String(this.epoch);
      if (
        (input.syncToken !== null && sync?.[1] !== epoch) ||
        (input.pageToken !== null && page?.[1] !== epoch)
      ) {
        return 'sync_expired' as const;
      }
      const since = sync?.[2] === undefined ? 0 : Number(sync[2]);
      const upTo = page?.[2] === undefined ? this.changeCount : Number(page[2]);
      // Pages go on after the last change number given, never by position: an event changed
      // between two pages moves past `upTo` and comes with the next sync, none is skipped.
      const after = Math.max(since, page?.[3] === undefined ? 0 : Number(page[3]));
      const changed = [...events.entries()]
        .filter(([, event]) => event.changed > after && event.changed <= upTo)
        .sort(([, a], [, b]) => a.changed - b.changed);
      const slice = changed.slice(0, this.pageSize);
      const more = this.pageSize < changed.length;
      const last = slice.at(-1)?.[1].changed ?? after;
      return {
        events: slice.map(([id, event]) => listed(id, event)),
        nextPageToken: more ? `sbx-page-${epoch}-${String(upTo)}-${String(last)}` : null,
        nextSyncToken: more ? null : `sbx-sync-${epoch}-${String(upTo)}`,
      };
    });
  }

  /** A member changes or deletes a Pepper event in Google (tests). */
  changeInGoogle(
    calendarId: string,
    eventId: string,
    change: SandboxEvent['inGoogle'] | 'delete',
  ): void {
    const event = this.calendars.get(calendarId)?.get(eventId);
    if (event === undefined) throw new Error(`No event ${eventId} in ${calendarId}`);
    if (change === 'delete') event.status = 'cancelled';
    else event.inGoogle = { ...event.inGoogle, ...change };
    event.changed = this.next();
  }

  /** A member adds an event of their own to "Pepper bookings" (tests). */
  addOwnEvent(calendarId: string, eventId: string, summary: string): void {
    const body = calendarEventBodyOf({
      bookingId: randomUUID(),
      serviceName: summary,
      clientFirstName: '',
      startsAt: new Date(this.now()),
      endsAt: new Date(this.now() + HOUR_MS),
    });
    this.calendarOf(calendarId).set(eventId, {
      body: { ...body, id: eventId },
      status: 'confirmed',
      changed: this.next(),
    });
  }

  /** Every sync and page token given so far answers 410 (Google's token expiry, tests). */
  expireSyncTokens(): void {
    this.epoch += 1;
  }

  /** The event as a member would see it in Google now (tests). */
  seenInGoogle(calendarId: string, eventId: string): GoogleListedEvent | undefined {
    const event = this.calendars.get(calendarId)?.get(eventId);
    return event === undefined ? undefined : listed(eventId, event);
  }

  private next(): number {
    this.changeCount += 1;
    return this.changeCount;
  }

  /** The events of a calendar that aren't cancelled (tests): Pepper's bodies as last written. */
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

/** An event as `events.list` gives it: Pepper's body with what a member changed over it. */
function listed(id: string, event: SandboxEvent): GoogleListedEvent {
  if (event.status === 'cancelled') return { id, status: 'cancelled' };
  return {
    id,
    status: 'confirmed',
    summary: event.inGoogle?.summary ?? event.body.summary,
    start: event.inGoogle?.start ?? { dateTime: event.body.start.dateTime },
    end: event.inGoogle?.end ?? { dateTime: event.body.end.dateTime },
  };
}
