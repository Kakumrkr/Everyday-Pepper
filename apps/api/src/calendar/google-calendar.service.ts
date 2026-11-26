import type {
  BusyQuery,
  CalendarConnectComplete,
  CalendarConnectionAnswer,
  CalendarConnectStart,
  OutsideBusyTime,
  TeamCalendarConnections,
} from '@pepper/contracts';
import { systemClock, type Actor, type Clock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import {
  calendarProviderFor,
  calendarTokenKeyFrom,
  completeCalendarConnect,
  disconnectCalendar,
  listOutsideBusy,
  readOwnCalendar,
  readTeamCalendars,
  startCalendarConnect,
  type CalendarDeps,
} from '@pepper/google-calendar';
import { currentRequestContext, DATABASE, type GoogleCalendarConfig } from '@pepper/runtime';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { apiError } from '../auth/guards.js';

// The api's side of Google Calendar (S70, ADR-0069): binds the module's services to this
// deployment's provider. Off: every connection route is 404 `calendar_off`; the busy times
// already stored are still read (none are written while off).

export interface GoogleCalendarOptions {
  /** `null`: off here. The sandbox only where tests may run (api config). */
  config: GoogleCalendarConfig | null;
  /** Pepper's public origin (`AUTH_BASE_URL`): Google's return page is on it. */
  baseUrl: string;
  outboxKey: Buffer;
  clock?: Clock;
}

export const GOOGLE_CALENDAR_OPTIONS = Symbol('GOOGLE_CALENDAR_OPTIONS');

@Injectable()
export class GoogleCalendarService {
  private readonly deps: CalendarDeps | null;
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(GOOGLE_CALENDAR_OPTIONS) options: GoogleCalendarOptions,
  ) {
    this.db = database.db;
    this.deps = bind(database.db, options);
  }

  async own(tenant: TenantContext): Promise<CalendarConnectionAnswer> {
    return readOwnCalendar(this.on(), actorOf(tenant));
  }

  /** The Team list's calendar states (AC-X-165); 404 `calendar_off` when off. */
  async team(tenant: TenantContext, limit: number): Promise<TeamCalendarConnections> {
    return readTeamCalendars(this.on(), actorOf(tenant), limit);
  }

  async connect(tenant: TenantContext): Promise<CalendarConnectStart> {
    return startCalendarConnect(this.on(), actorOf(tenant));
  }

  async complete(
    tenant: TenantContext,
    input: CalendarConnectComplete,
  ): Promise<CalendarConnectionAnswer> {
    return completeCalendarConnect(this.on(), actorOf(tenant), input);
  }

  async disconnect(tenant: TenantContext): Promise<void> {
    await disconnectCalendar(this.on(), actorOf(tenant));
  }

  async outsideBusy(
    tenant: TenantContext,
    query: BusyQuery,
    limit: number,
  ): Promise<OutsideBusyTime[]> {
    return listOutsideBusy(this.db, actorOf(tenant), query, limit);
  }

  private on(): CalendarDeps {
    if (this.deps === null) throw new NotFoundException(apiError('calendar_off'));
    return this.deps;
  }
}

function bind(db: Database, options: GoogleCalendarOptions): CalendarDeps | null {
  const { config } = options;
  if (config === null) return null;
  const clock = options.clock ?? systemClock;
  return {
    db,
    clock,
    tokenKey: calendarTokenKeyFrom(options.outboxKey),
    provider: calendarProviderFor(config, options.baseUrl, () => clock.now().getTime()),
  };
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
