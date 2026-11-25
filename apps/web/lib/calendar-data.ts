import {
  BookingsResponseSchema,
  BusyResponseSchema,
  ClientNamesResponseSchema,
  MAX_CLIENT_NAMES,
  ServicesResponseSchema,
  StaffResponseSchema,
  TimeOffResponseSchema,
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

export interface CalendarDay {
  staff: StaffMember[];
  services: Service[];
  /** Bookings the member may see in full (staff: their own), cancelled ones left out. */
  bookings: Booking[];
  /** Everyone's busy times, without details (for colleagues' columns). */
  busy: BusyTime[];
  /** Client names by id, for the bookings shown (S50.2: one `GET /v1/clients/names`). */
  clientNames: Map<string, VisitClient>;
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
}

/**
 * Everything the week view shows (S69, AC-X-144…146): the team and services first, then for the
 * one staff member `pick` chooses, their bookings, busy times, working hours and time off in
 * [from, to), in parallel. Only that member's visits are asked for, so a busy team's week stays
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
      truncated: false,
      failed: staff === null || services === null,
      hours: null,
      timeOff: [],
    };
  }
  const path = `/v1/staff/${encodeURIComponent(member.id)}`;
  const [visits, hours, timeOff] = await Promise.all([
    loadVisits(options, range, member.id),
    loadJson(`${path}/hours`, WeeklyHoursSchema, options),
    loadJson(
      `${path}/time-off?${new URLSearchParams({ from: range.from }).toString()}`,
      TimeOffResponseSchema,
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
  };
}

/** The bookings (cancelled ones left out), busy times and client names of [from, to). */
async function loadVisits(
  options: ApiCallOptions,
  range: { from: string; to: string },
  staffMemberId: string | null,
): Promise<Pick<CalendarDay, 'bookings' | 'busy' | 'clientNames' | 'truncated' | 'failed'>> {
  const query = new URLSearchParams({
    ...range,
    ...(staffMemberId === null ? {} : { staffMemberId }),
  }).toString();
  const [bookings, busy] = await Promise.all([
    loadJson(`/v1/bookings?${query}`, BookingsResponseSchema, options),
    loadJson(`/v1/calendar/busy?${query}`, BusyResponseSchema, options),
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
