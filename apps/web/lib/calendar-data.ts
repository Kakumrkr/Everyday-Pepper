import {
  BookingsResponseSchema,
  BusyResponseSchema,
  ClientSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
  type Booking,
  type BusyTime,
  type MembershipRole,
  type Service,
  type StaffMember,
} from '@floty/contracts';
import { loadJson, type ApiCallOptions } from './account';

/** The most client names one day view looks up (one request each); others show as "Client". */
export const MAX_CLIENT_LOOKUPS = 60;

export interface CalendarDay {
  staff: StaffMember[];
  services: Service[];
  /** Bookings the member may see in full (staff: their own), cancelled ones left out. */
  bookings: Booking[];
  /** Everyone's busy times, without details (for colleagues' columns). */
  busy: BusyTime[];
  /** Client names by id, for the bookings shown. */
  clientNames: Map<string, string>;
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
  const query = new URLSearchParams(range).toString();
  const [staff, services, bookings, busy] = await Promise.all([
    loadJson('/v1/staff', StaffResponseSchema, options),
    loadJson('/v1/services', ServicesResponseSchema, options),
    loadJson(`/v1/bookings?${query}`, BookingsResponseSchema, options),
    loadJson(`/v1/calendar/busy?${query}`, BusyResponseSchema, options),
  ]);
  const shown = (bookings?.bookings ?? []).filter((booking) => booking.status !== 'cancelled');
  const clientIds = [...new Set(shown.map((booking) => booking.clientId))].slice(
    0,
    MAX_CLIENT_LOOKUPS,
  );
  const clients = await Promise.all(
    clientIds.map((id) => loadJson(`/v1/clients/${encodeURIComponent(id)}`, ClientSchema, options)),
  );
  return {
    staff: staff?.staff ?? [],
    services: services?.services ?? [],
    bookings: shown,
    busy: busy?.busy ?? [],
    clientNames: new Map(
      clients.flatMap((client) => (client === null ? [] : [[client.id, client.name] as const])),
    ),
    truncated: bookings?.truncated === true || busy?.truncated === true,
    failed: [staff, services, bookings, busy].some((answer) => answer === null),
  };
}
