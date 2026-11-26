import {
  BookingsResponseSchema,
  BusyResponseSchema,
  KeptBookingsResponseSchema,
  OutsideBusyResponseSchema,
  ClientNamesResponseSchema,
  MAX_CLIENT_NAMES,
  ServicesResponseSchema,
  StaffResponseSchema,
  TimeOffResponseSchema,
  VisitNumbersResponseSchema,
  WeeklyHoursSchema,
  type Booking,
  type BusyTime,
  type MembershipRole,
  type Service,
  type StaffMember,
  type WorkingInterval,
} from '@pepper/contracts';
import { loadJson, type ApiCallOptions } from './account';
import type { Timed } from './calendar';

/** The most client names one day view looks up (in one request); others show as "Client". */
export const MAX_CLIENT_LOOKUPS = MAX_CLIENT_NAMES;

/** A client's name on a visit; `deleted` (ADR-0051): "Deleted client", no profile to open. */
export interface VisitClient {
  name: string;
  deleted: boolean;
}

/** A series visit's place in its series: visit `number` of `of` (S72.2). */
export interface VisitPlace {
  number: number;
  of: number;
}

export interface CalendarDay {
  staff: StaffMember[];
  services: Service[];
  /** Bookings the member may see in full (staff: their own), cancelled ones left out. */
  bookings: Booking[];
  /** Everyone's busy times, without details (for colleagues' columns). */
  busy: BusyTime[];
  /** Client names by id, for the bookings shown (S50.2: one `GET /v1/clients/names`). */
  clientNames: Map<string, VisitClient>;
  /**
   * "2 of 8" by booking id for the visits of a series (S72.2, AC-X-194), read for the range at
   * once; empty when it couldn't be loaded (the blocks then just leave it out).
   */
  visits: ReadonlyMap<string, VisitPlace>;
  /** Some answer stopped at the api's limit (`MAX_LIST_ITEMS`). */
  truncated: boolean;
  /** Something could not be loaded: the view is incomplete. */
  failed: boolean;
}

/** Whether the member sees a staff member's bookings in full (else only busy times). */
export function seesDetailsOf(
  role: MembershipRole,
  userId: string,
  member: Pick<StaffMember, 'userId'>,
): boolean {
  return role !== 'staff' || member.userId === userId;
}

/** Everything the day view shows for [from, to), asked from the api in parallel. */
export async function loadCalendarDay(
  options: ApiCallOptions,
  range: { from: string; to: string },
): Promise<CalendarDay> {
  const [staff, services, visits] = await Promise.all([
    loadJson('/v1/staff', StaffResponseSchema, options),
    loadJson('/v1/services', ServicesResponseSchema, options),
    loadVisits(options, range, null),
  ]);
  return {
    staff: staff?.staff ?? [],
    services: services?.services ?? [],
    ...visits,
    failed: visits.failed || staff === null || services === null,
  };
}

export interface CalendarWeek extends CalendarDay {
  /** The staff member whose week it is; `null` without anyone to show. */
  member: StaffMember | null;
  /** Their weekly working hours; `null` when they couldn't be loaded (nothing is shaded). */
  hours: WorkingInterval[] | null;
  /** Their time off in the week. */
  timeOff: Timed[];
  /**
   * When their Google Calendar says they're busy in the week (S70, AC-X-159): times only. Empty
   * when none is connected, or the read failed (the api still refuses those times).
   */
  outside: Timed[];
  /**
   * The bookings Pepper kept over a change made in Google in the last 7 days (S72 top-up,
   * AC-X-188), read for the whole week at once; empty with Google Calendar off or none kept.
   */
  kept: ReadonlySet<string>;
}

/**
 * Everything the week view shows (S69, AC-X-144…146): the team and services first, then for the
 * one staff member `pick` chooses, their bookings, busy times, working hours, time off and
 * Google busy times (S70) in [from, to), in parallel. Only that member's visits are asked for, so a busy team's week stays
 * under the api's list limit.
 */
export async function loadCalendarWeek(
  options: ApiCallOptions,
  range: { from: string; to: string },
  pick: (staff: readonly StaffMember[]) => StaffMember | null,
): Promise<CalendarWeek> {
  const [staff, services] = await Promise.all([
    loadJson('/v1/staff', StaffResponseSchema, options),
    loadJson('/v1/services', ServicesResponseSchema, options),
  ]);
  const team = staff?.staff ?? [];
  const member = pick(team);
  const base = {
    staff: team,
    services: services?.services ?? [],
    member,
  };
  if (member === null) {
    return {
      ...base,
      bookings: [],
      busy: [],
      clientNames: new Map(),
      visits: new Map(),
      truncated: false,
      failed: staff === null || services === null,
      hours: null,
      timeOff: [],
      outside: [],
      kept: new Set(),
    };
  }
  const path = `/v1/staff/${encodeURIComponent(member.id)}`;
  const [visits, hours, timeOff, outside, kept] = await Promise.all([
    loadVisits(options, range, member.id),
    loadJson(`${path}/hours`, WeeklyHoursSchema, options),
    loadJson(
      `${path}/time-off?${new URLSearchParams({ from: range.from }).toString()}`,
      TimeOffResponseSchema,
      options,
    ),
    loadJson(
      `/v1/calendar/outside-busy?${new URLSearchParams({ ...range, staffMemberId: member.id }).toString()}`,
      OutsideBusyResponseSchema,
      options,
    ),
    loadJson(
      `/v1/calendar/kept?${new URLSearchParams({ ...range, staffMemberId: member.id }).toString()}`,
      KeptBookingsResponseSchema,
      options,
    ),
  ]);
  return {
    ...base,
    ...visits,
    failed: visits.failed || staff === null || services === null,
    hours: hours?.intervals ?? null,
    timeOff: (timeOff?.timeOff ?? [])
      .filter((entry) => entry.startsAt < range.to && entry.endsAt > range.from)
      .map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    outside: (outside?.busy ?? []).map(({ startsAt, endsAt }) => ({ startsAt, endsAt })),
    kept: new Set(kept?.bookingIds ?? []),
  };
}

/** The bookings (cancelled ones left out), busy times and client names of [from, to). */
async function loadVisits(
  options: ApiCallOptions,
  range: { from: string; to: string },
  staffMemberId: string | null,
): Promise<
  Pick<CalendarDay, 'bookings' | 'busy' | 'clientNames' | 'visits' | 'truncated' | 'failed'>
> {
  const query = new URLSearchParams({
    ...range,
    ...(staffMemberId === null ? {} : { staffMemberId }),
  }).toString();
  const [bookings, busy, visits] = await Promise.all([
    loadJson(`/v1/bookings?${query}`, BookingsResponseSchema, options),
    loadJson(`/v1/calendar/busy?${query}`, BusyResponseSchema, options),
    loadJson(`/v1/calendar/visit-numbers?${query}`, VisitNumbersResponseSchema, options),
  ]);
  const shown = (bookings?.bookings ?? []).filter((booking) => booking.status !== 'cancelled');
  const clientIds = [...new Set(shown.map((booking) => booking.clientId))].slice(
    0,
    MAX_CLIENT_LOOKUPS,
  );
  const names =
    clientIds.length === 0
      ? null
      : await loadJson(
          `/v1/clients/names?ids=${clientIds.map(encodeURIComponent).join(',')}`,
          ClientNamesResponseSchema,
          options,
        );
  return {
    bookings: shown,
    busy: busy?.busy ?? [],
    clientNames: new Map(
      (names?.names ?? []).map((client) => [
        client.id,
        { name: client.name, deleted: client.deleted },
      ]),
    ),
    visits: new Map(
      (visits?.visits ?? []).map(({ bookingId, number, of }) => [bookingId, { number, of }]),
    ),
    truncated: bookings?.truncated === true || busy?.truncated === true,
    failed: bookings === null || busy === null,
  };
}

/**
 * What a booking on the calendar names (S50.2, AC-W1-36): the client's name and the profile to
 * link to; a deleted client is "Deleted client" with no profile, one not found "Client".
 */
export function visitClient(
  known: VisitClient | undefined,
  clientId: string,
): { client: string; clientId: string | null } {
  if (known === undefined) return { client: 'Client', clientId: null };
  return { client: known.name, clientId: known.deleted ? null : clientId };
}
