import {
  changeBookingIn,
  createBookingIn,
  findAvailabilityIn,
  getBookingIn,
  reinstateBookingIn,
  SlotUnavailableError,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  UtcDateTimeSchema,
  type AutonomyAction,
  type AvailableSlot,
  type Booking,
  type BookingView,
  type StaffMemberId,
  type TrustJson,
} from '@pepper/contracts';
import { ForbiddenError, permissionScope, UndoRefusedError } from '@pepper/core';
import { z } from 'zod';
import { instantOf } from '../local-time.js';
import type { Performed, ToolScope, WriteScope, WriteTool } from '../tool.js';
import { bookingMemory } from './recall.js';
import {
  bookingSide,
  bookingView,
  clientNames,
  DateArg,
  directoryOf,
  domainOptions,
  EmailClientArg,
  IdArg,
  ownStaffMember,
  staffLogin,
  TimeArg,
  when,
  type Directory,
} from './shared.js';

// The booking write tools (ADR-0029): create, move and cancel through the same domain services
// as the calendar screens, inside the trust layer's transaction. The tools never pass
// `override` (hours and rules always apply to the AI) and never take the business or the member
// from the model. The client's email is a dial action of its own (`message.confirmation`).

const MINUTE_MS = 60_000;

/** The change, plus the client's email unless the member said not to send one. */
function withEmail(
  action: AutonomyAction,
  emailClient: boolean | null,
): readonly [AutonomyAction, ...AutonomyAction[]] {
  return emailClient === false ? [action] : [action, 'message.confirmation'];
}

async function viewOf(scope: ToolScope, directory: Directory, booking: Booking) {
  return bookingView(scope, directory, await clientNames(scope, [booking.clientId]), booking);
}

const CreateArgs = z.strictObject({
  clientId: IdArg('client'),
  serviceId: IdArg('service'),
  staffMemberId: IdArg('staff member')
    .nullable()
    .describe('null: the member themselves if they are staff, else the first one free then'),
  date: DateArg,
  time: TimeArg,
  emailClient: EmailClientArg,
});
type CreateArgs = z.output<typeof CreateArgs>;

export const createBooking: WriteTool = {
  kind: 'write',
  name: 'create_booking',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: 'Book a client (id from find_clients) for a service at a date and time the member chose.',
    avoid: [
      'without a client id from find_clients and a service id from list_services_and_staff',
      'to pick a time yourself (find_availability, then let the member choose), unless they asked you to find a time and book it: then book the first one that fits what they said',
      'to book outside opening hours or the rules (only a person can, on the calendar)',
    ],
    returns:
      'the booking, done or waiting for the member’s OK. If the time is taken, the 3 nearest free times: offer them.',
    examples: [
      {
        say: 'Book Maria for a haircut tomorrow at 10',
        args: { clientId: { $any: true }, serviceId: { $any: true }, time: '10:00' },
      },
      {
        say: "Put Sarah Park in for a haircut with Jess on Friday at 10:30am, don't email her",
        args: { staffMemberId: { $any: true }, time: '10:30', emailClient: false },
      },
    ],
  },
  args: CreateArgs,
  actions: (args: CreateArgs) => withEmail('booking.create', args.emailClient),
  async perform(scope: WriteScope, args: CreateArgs): Promise<Performed> {
    const directory = await directoryOf(scope);
    const clientId = ClientIdSchema.parse(args.clientId);
    const serviceId = ServiceIdSchema.parse(args.serviceId);
    const startsAt = instantOf(scope.timeZone, args.date, args.time);
    const staffMemberId =
      args.staffMemberId === null
        ? await chooseStaff(scope, directory, serviceId, startsAt)
        : StaffMemberIdSchema.parse(args.staffMemberId);
    const booking = await createBookingIn(
      scope.tx,
      scope.actor,
      {
        clientId,
        serviceId,
        staffMemberId,
        startsAt: UtcDateTimeSchema.parse(startsAt),
        notifyClient: args.emailClient ?? true,
      },
      { ...domainOptions(scope), source: 'ai', notify: scope.notifyClient(clientId) },
    );
    const view = await viewOf(scope, directory, booking);
    const remembered = await bookingMemory(scope, directory, { clientId, serviceId });
    return {
      entity: { type: 'booking', id: booking.id },
      targetKey: `booking.new:${clientId}:${startsAt}`,
      recordOwner: staffLogin(directory, staffMemberId),
      appointmentStartsAt: new Date(booking.startsAt),
      before: null,
      after: bookingSide(view, { withId: false }),
      touched: null,
      inverse: { bookingId: booking.id, startsAt: booking.startsAt, staffMemberId },
      summary: `New booking: ${view.clientName}, ${view.serviceName} with ${view.staffName}, ${when(view.date, view.time)}.`,
      facts: [
        slotWasFree(view),
        ...(args.staffMemberId === null
          ? [{ kind: 'staff_chosen', ref: null, value: { staffName: view.staffName } }]
          : []),
        ...remembered.facts,
      ],
      ...(remembered.memory !== undefined && { memory: remembered.memory }),
    };
  },
  async undo(scope, inverse) {
    const { bookingId, startsAt, staffMemberId } = BookingInverse.parse(inverse);
    const current = await getBookingIn(scope.tx, scope.actor, bookingId);
    if (
      current.status !== 'confirmed' ||
      current.startsAt !== startsAt ||
      current.staffMemberId !== staffMemberId
    ) {
      throw new UndoRefusedError('changed_since');
    }
    await changeBookingIn(
      scope.tx,
      scope.actor,
      bookingId,
      { status: 'cancelled', notifyClient: false },
      domainOptions(scope),
    );
  },
};

const BookingInverse = z.strictObject({
  bookingId: BookingIdSchema,
  startsAt: UtcDateTimeSchema,
  staffMemberId: StaffMemberIdSchema,
});

/**
 * Who a booking without a named staff member goes to: a staff member books themselves; owners
 * and managers get the first one free at that time (by name), or the nearest free times.
 */
async function chooseStaff(
  scope: ToolScope,
  directory: Directory,
  serviceId: z.infer<typeof ServiceIdSchema>,
  startsAt: string,
): Promise<StaffMemberId> {
  if (permissionScope(scope.actor.context.role, 'bookings.manage') !== 'all') {
    const own = ownStaffMember(scope, directory);
    if (own === undefined) throw new ForbiddenError('bookings.manage');
    return own.id;
  }
  // A lead approving a member's request: "book me" still books that member (S26).
  if (scope.requester !== scope.actor.context.userId) {
    const theirs = ownStaffMember(scope, directory);
    if (theirs !== undefined) return theirs.id;
  }
  const start = Date.parse(startsAt);
  const around = await findAvailabilityIn(
    scope.tx,
    scope.actor,
    {
      serviceId,
      from: new Date(start - 2 * 24 * 60 * MINUTE_MS).toISOString(),
      to: new Date(start + 3 * 24 * 60 * MINUTE_MS).toISOString(),
    },
    domainOptions(scope),
  );
  const exact = around.find((slot) => slot.startsAt === new Date(start).toISOString());
  if (exact !== undefined) return exact.staffMemberId;
  throw new SlotUnavailableError(nearest(around, start));
}

/** The 3 nearest start times to `start`, one per time, nearest first (AC-W2-1). */
function nearest(slots: readonly AvailableSlot[], start: number): AvailableSlot[] {
  const seen = new Set<string>();
  return [...slots]
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.startsAt) - start) - Math.abs(Date.parse(b.startsAt) - start) ||
        Date.parse(a.startsAt) - Date.parse(b.startsAt),
    )
    .filter((slot) => !seen.has(slot.startsAt) && seen.add(slot.startsAt))
    .slice(0, 3);
}

const MoveArgs = z.strictObject({
  bookingId: IdArg('booking'),
  date: DateArg,
  time: TimeArg,
  staffMemberId: IdArg('staff member')
    .nullable()
    .describe('Another staff member who offers the service; null: the same one'),
  emailClient: EmailClientArg,
});
type MoveArgs = z.output<typeof MoveArgs>;

const MoveInverse = z.strictObject({
  bookingId: BookingIdSchema,
  from: z.strictObject({ startsAt: UtcDateTimeSchema, staffMemberId: StaffMemberIdSchema }),
  to: z.strictObject({ startsAt: UtcDateTimeSchema, staffMemberId: StaffMemberIdSchema }),
});

export const moveBooking: WriteTool = {
  kind: 'write',
  name: 'move_booking',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  guide: {
    use: 'Move a booking (its id from find_client_bookings when the member names the client, else from get_day) to another date and time, optionally to another staff member who offers the service.',
    avoid: [
      'to change the service or the client (cancel and book again)',
      'to pick the new time yourself (offer free times and let the member choose)',
    ],
    returns:
      'the move, done or waiting for the member’s OK. If the time is taken, the 3 nearest free times: offer them.',
    examples: [
      {
        say: "Move Maria's 3pm to 4pm",
        args: { bookingId: { $any: true }, time: '16:00', staffMemberId: null },
      },
      {
        say: "Shift Ana's Friday cut to Saturday at 11 with Marco",
        args: { bookingId: { $any: true }, time: '11:00', staffMemberId: { $any: true } },
      },
    ],
  },
  args: MoveArgs,
  actions: (args: MoveArgs) => withEmail('booking.move', args.emailClient),
  async perform(scope: WriteScope, args: MoveArgs): Promise<Performed> {
    const directory = await directoryOf(scope);
    const id = BookingIdSchema.parse(args.bookingId);
    const before = await getBookingIn(scope.tx, scope.actor, id);
    const startsAt = UtcDateTimeSchema.parse(instantOf(scope.timeZone, args.date, args.time));
    const moved = await changeBookingIn(
      scope.tx,
      scope.actor,
      id,
      {
        startsAt,
        ...(args.staffMemberId !== null && {
          staffMemberId: StaffMemberIdSchema.parse(args.staffMemberId),
        }),
        notifyClient: args.emailClient ?? true,
      },
      { ...domainOptions(scope), notify: scope.notifyClient(before.clientId) },
    );
    const from = await viewOf(scope, directory, before);
    const to = await viewOf(scope, directory, moved);
    const remembered = await bookingMemory(scope, directory, {
      clientId: moved.clientId,
      serviceId: moved.serviceId,
    });
    return {
      entity: { type: 'booking', id },
      targetKey: `booking:${id}`,
      recordOwner: staffLogin(directory, before.staffMemberId),
      appointmentStartsAt: new Date(
        Math.min(Date.parse(before.startsAt), Date.parse(moved.startsAt)),
      ),
      before: bookingSide(from, { withId: true }),
      after: bookingSide(to, { withId: true }),
      touched: { bookingUpdatedAt: before.updatedAt },
      inverse: {
        bookingId: id,
        from: { startsAt: before.startsAt, staffMemberId: before.staffMemberId },
        to: { startsAt: moved.startsAt, staffMemberId: moved.staffMemberId },
      },
      summary: `Move ${to.clientName}'s ${to.serviceName} from ${when(from.date, from.time)} with ${from.staffName} to ${when(to.date, to.time)} with ${to.staffName}.`,
      facts: [slotWasFree(to), ...remembered.facts],
      ...(remembered.memory !== undefined && { memory: remembered.memory }),
    };
  },
  async undo(scope, inverse) {
    const { bookingId, from, to } = MoveInverse.parse(inverse);
    const current = await getBookingIn(scope.tx, scope.actor, bookingId);
    if (
      current.status !== 'confirmed' ||
      current.startsAt !== to.startsAt ||
      current.staffMemberId !== to.staffMemberId
    ) {
      throw new UndoRefusedError('changed_since');
    }
    await changeBookingIn(
      scope.tx,
      scope.actor,
      bookingId,
      { startsAt: from.startsAt, staffMemberId: from.staffMemberId, notifyClient: false },
      domainOptions(scope),
    );
  },
};

const CancelArgs = z.strictObject({
  bookingId: IdArg('booking'),
  emailClient: EmailClientArg,
});
type CancelArgs = z.output<typeof CancelArgs>;

export const cancelBooking: WriteTool = {
  kind: 'write',
  name: 'cancel_booking',
  version: 1,
  localTimes: false,
  tier: 'internal_write',
  guide: {
    use: 'Cancel a booking the member asked to cancel (its id from find_client_bookings when the member names the client, else from get_day).',
    avoid: [
      'to move a booking (use move_booking)',
      'for a no-show or a finished appointment (the calendar records those)',
      'for several bookings at once unless the member named each one',
    ],
    returns: 'the cancellation, done or waiting for the member’s OK.',
    examples: [
      {
        say: "Cancel Maria's appointment on Friday",
        evalSay: "Cancel Maria's appointment tomorrow",
        args: { bookingId: { $any: true } },
      },
      {
        say: "Cancel Ana's 2pm but don't email her",
        args: { bookingId: { $any: true }, emailClient: false },
      },
    ],
  },
  args: CancelArgs,
  actions: (args: CancelArgs) => withEmail('booking.cancel', args.emailClient),
  async perform(scope: WriteScope, args: CancelArgs): Promise<Performed> {
    const directory = await directoryOf(scope);
    const id = BookingIdSchema.parse(args.bookingId);
    const before = await getBookingIn(scope.tx, scope.actor, id);
    const cancelled = await changeBookingIn(
      scope.tx,
      scope.actor,
      id,
      { status: 'cancelled', notifyClient: args.emailClient ?? true },
      { ...domainOptions(scope), notify: scope.notifyClient(before.clientId) },
    );
    const was = await viewOf(scope, directory, before);
    const now = await viewOf(scope, directory, cancelled);
    return {
      entity: { type: 'booking', id },
      targetKey: `booking:${id}`,
      recordOwner: staffLogin(directory, before.staffMemberId),
      appointmentStartsAt: new Date(before.startsAt),
      before: bookingSide(was, { withId: true }),
      after: bookingSide(now, { withId: true }),
      touched: { bookingUpdatedAt: before.updatedAt },
      inverse: { bookingId: id } satisfies TrustJson,
      summary: `Cancel ${was.clientName}'s ${was.serviceName} with ${was.staffName}, ${when(was.date, was.time)}.`,
      facts: [{ kind: 'not_started', ref: null, value: { date: was.date, time: was.time } }],
    };
  },
  async undo(scope, inverse) {
    const { bookingId } = z.strictObject({ bookingId: BookingIdSchema }).parse(inverse);
    await reinstateBookingIn(scope.tx, scope.actor, bookingId, domainOptions(scope));
  },
};

/** *Why?*: the booking services refuse a taken time, so a booking made means it was free. */
function slotWasFree(view: BookingView) {
  return {
    kind: 'slot_was_free',
    ref: null,
    value: { date: view.date, time: view.time, staffName: view.staffName },
  };
}
