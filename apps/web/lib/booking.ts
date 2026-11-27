import {
  canChangeStatus,
  formatDate,
  fromZoned,
  minutesOfDay,
  statusNeedsStart,
  shortDateTimeWords,
  toZoned,
  type BookingStatus,
  type CivilDate,
  type Permission,
  type Service,
  type StaffMember,
  type WaitlistWindow,
  type WalkInClient,
  WalkInClientSchema,
} from '@pepper/contracts';
import { dayRange, timeRange } from './calendar';
import { KEPT_OVER_GOOGLE } from './calendar-connect';

// The booking screens (S15): who can be booked, the times to offer and what a booking sheet
// may do. Everything here is pure; the screens call the api, which decides (AC-W9-1).

/** What the member may do on the booking screens, from their role's permissions. */
export interface BookingAbilities {
  /** Book and change bookings (staff: their own staff member's). */
  books: boolean;
  /** Search clients by name and add new ones (owners and managers). */
  managesClients: boolean;
  /** Change a done or no-show booking again (owners and managers, rule (b)). */
  correctsOutcomes: boolean;
  /** Book only the staff member linked to their own login (staff, AC-W9-1). */
  ownStaffOnly: boolean;
  /** Read and change visit notes (staff: their own clients' visits, S32). */
  readsNotes: boolean;
  managesNotes: boolean;
  /** Read a booking's deposit on its sheet (owners and managers, S67, AC-X-129). */
  readsPayments: boolean;
}

export function bookingAbilities(
  permissions: readonly Permission[],
  role: 'owner' | 'manager' | 'staff',
): BookingAbilities {
  return {
    books: permissions.includes('bookings.manage'),
    managesClients: permissions.includes('clients.manage'),
    correctsOutcomes: role !== 'staff',
    ownStaffOnly: role === 'staff',
    readsNotes: permissions.includes('client_notes.read'),
    managesNotes: permissions.includes('client_notes.manage'),
    readsPayments: permissions.includes('payments.read'),
  };
}

/** What every booking screen needs to know about the business and the member. */
export interface BookingSetup {
  timeZone: string;
  userId: string;
  abilities: BookingAbilities;
  /** Active services, by name. */
  services: Service[];
  /** Every staff member (names for any booking); `bookableStaff` picks whom to offer. */
  staff: StaffMember[];
}

/**
 * The staff members the member may book: active ones (with `serviceId`, only those who offer
 * it). Staff book only the staff member linked to their own login.
 */
export function bookableStaff(
  staff: readonly StaffMember[],
  options: { userId: string; ownOnly: boolean; serviceId?: string },
): StaffMember[] {
  return staff.filter(
    (member) =>
      member.active &&
      (!options.ownOnly || member.userId === options.userId) &&
      (options.serviceId === undefined || member.serviceIds.some((id) => id === options.serviceId)),
  );
}

/** `GET /v1/availability` for one service (and staff member) over the business's local day. */
export function availabilityPath(
  timeZone: string,
  date: CivilDate,
  query: { serviceId: string; staffMemberId?: string },
): string {
  const params = new URLSearchParams({ ...dayRange(timeZone, date), serviceId: query.serviceId });
  if (query.staffMemberId !== undefined) params.set('staffMemberId', query.staffMemberId);
  return `/v1/availability?${params.toString()}`;
}

/** `9:15 AM` on the business's clock. */
export function timeLabel(timeZone: string, instant: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(
    new Date(instant),
  );
}

/** `Tue, Nov 3, 9:15 AM` on the business's clock (the policy's and the emails' own words). */
export const dateTimeLabel = shortDateTimeWords;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The instant of a wall-clock `HH:MM` on a local date of the business, or `null` for a
 * malformed time. A time skipped by a clock change resolves as `fromZoned` does.
 */
export function instantAt(timeZone: string, date: CivilDate, time: string): string | null {
  if (!TIME_PATTERN.test(time)) return null;
  return new Date(fromZoned(timeZone, date, minutesOfDay(time))).toISOString();
}

/** The business's local date (`YYYY-MM-DD`) and time (`HH:MM`) of an instant. */
export function localParts(timeZone: string, instant: string): { date: string; time: string } {
  const zoned = toZoned(timeZone, Date.parse(instant));
  return { date: formatDate(zoned), time: clockTime(zoned.minuteOfDay) };
}

/**
 * When the client confirmed the visit by replying C to a reminder (S62, AC-X-79), while it is
 * still booked; `null` otherwise. Moving a booking clears it on the api until they confirm again.
 */
export function confirmedByText(booking: {
  status: BookingStatus;
  clientConfirmedAt?: string | null | undefined;
}): string | null {
  return booking.status === 'confirmed' ? (booking.clientConfirmedAt ?? null) : null;
}

/** "Confirmed by text" or "Confirmed by link" (S78 top-up, AC-X-205). */
export function confirmedLabel(booking: {
  clientConfirmedVia?: 'text' | 'link' | null | undefined;
}): string {
  return booking.clientConfirmedVia === 'link' ? 'Confirmed by link' : 'Confirmed by text';
}

/**
 * What a booking's block on the calendar is called (its accessible name): when, what and who,
 * then what its marks show: its place in a series (S72.2, AC-X-194), confirmed by text (S62),
 * kept over a Google change (S72, AC-X-188).
 */
export function bookingBlockName(
  timeZone: string,
  booking: {
    startsAt: string;
    endsAt: string;
    service: string;
    client: string;
    status: BookingStatus;
    clientConfirmedAt?: string | null | undefined;
    clientConfirmedVia?: 'text' | 'link' | null | undefined;
    keptOverGoogle?: boolean | undefined;
    visit?: { number: number; of: number } | null | undefined;
  },
): string {
  const { visit } = booking;
  const marks = [
    ...(visit ? [`visit ${String(visit.number)} of ${String(visit.of)}`] : []),
    ...(confirmedByText(booking) === null ? [] : [confirmedLabel(booking).toLowerCase()]),
    // "changed in Google, …": only the sentence's first letter lowered, never the names.
    ...(booking.keptOverGoogle === true
      ? [`${KEPT_OVER_GOOGLE.charAt(0).toLowerCase()}${KEPT_OVER_GOOGLE.slice(1)}`]
      : []),
  ];
  return [
    `${timeRange(timeZone, booking.startsAt, booking.endsAt)}, ${booking.service} with ${booking.client}`,
    ...marks,
  ].join(', ');
}

/** A booking's status in words. */
export const STATUS_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Booked',
  completed: 'Done',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

/** What a booking sheet offers for a booking's current status, at `now`. */
export interface BookingActions {
  complete: boolean;
  noShow: boolean;
  cancel: boolean;
  move: boolean;
}

export function bookingActions(
  booking: { status: BookingStatus; startsAt: string },
  now: number,
  correctsOutcomes: boolean,
): BookingActions {
  const started = Date.parse(booking.startsAt) <= now;
  const may = (to: BookingStatus) =>
    canChangeStatus(booking.status, to, correctsOutcomes) && (!statusNeedsStart(to) || started);
  return {
    complete: may('completed'),
    noShow: may('no_show'),
    cancel: may('cancelled'),
    move: booking.status === 'confirmed',
  };
}

/**
 * The waitlist window to suggest for a refused time: that local day, exactly the wanted
 * appointment (`minutes` long, to midnight at most). That time is taken, so the window is full
 * (the waitlist takes only full times, S44); the member can widen it before adding the entry.
 */
export function suggestedWindow(
  timeZone: string,
  startsAt: string,
  minutes: number,
): WaitlistWindow {
  const { date, time } = localParts(timeZone, startsAt);
  const end = Math.min(minutesOfDay(time) + minutes, 1440);
  return { date, start: time, end: clockTime(end) };
}

/** `HH:MM` for minutes after local midnight (1440 is `24:00`). */
function clockTime(minuteOfDay: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`;
}

/**
 * The exact contact a member typed, in the form the api expects: an email as typed (the api
 * lowercases it), a phone in E.164. US numbers may be typed locally (`(555) 123-4567` or
 * `1 555 123 4567`); other countries need their `+` code.
 */
export function normalizeContact(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('@')) return trimmed;
  const digits = trimmed.replace(/[\s().-]/g, '');
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits;
}

/** A walk-in staff add with their booking (S50.2, ADR-0052): created when the booking is. */
export type WalkIn = WalkInClient;

/**
 * What is wrong with a walk-in typed on the Book sheet, said so it can be fixed there (before
 * Book), or `null` when the api will take it.
 */
export function walkInProblem(walkIn: WalkIn): string | null {
  const parsed = WalkInClientSchema.safeParse(walkIn);
  if (parsed.success) return null;
  const field = parsed.error.issues[0]?.path[0];
  if (field === 'phone')
    return 'Type the phone as you’d dial it, e.g. (555) 123-4567, or leave it empty.';
  if (field === 'email') return 'Check the email address, or leave it empty.';
  return 'Type the client’s name.';
}

/**
 * A walk-in from what was typed on the Book sheet: the name trimmed, an empty email or phone
 * left out, a phone in E.164 (`normalizeContact`).
 */
export function walkInFrom(typed: { name: string; email: string; phone: string }): WalkIn {
  const email = typed.email.trim();
  const phone = typed.phone.trim();
  return {
    name: typed.name.trim(),
    email: email === '' ? null : email,
    phone: phone === '' ? null : normalizeContact(phone),
  };
}

/**
 * What a contact typed on the Book sheet fills in on "New client" when no client has it: an
 * email goes in the email field, anything else in the phone field.
 */
export function walkInPrefill(contact: string): { email: string; phone: string } {
  return contact.includes('@') ? { email: contact, phone: '' } : { email: '', phone: contact };
}

/**
 * The request that books the chosen client: `POST /v1/bookings` for a client who exists (with
 * the exact contact staff found them by, ADR-0020), `POST /v1/bookings/walk-in` with the new
 * client otherwise.
 */
export function bookingRequest(
  who: { clientId: string; contact?: string | undefined } | { walkIn: WalkIn },
  slot: Record<string, unknown>,
): { path: string; body: Record<string, unknown> } {
  if ('walkIn' in who)
    return { path: '/v1/bookings/walk-in', body: { ...slot, client: who.walkIn } };
  return {
    path: '/v1/bookings',
    body: {
      clientId: who.clientId,
      ...(who.contact !== undefined && { clientContact: who.contact }),
      ...slot,
    },
  };
}
