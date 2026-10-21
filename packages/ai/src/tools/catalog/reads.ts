import {
  findAvailabilityIn,
  getBookingIn,
  listBookingsIn,
  listTimeOffBetweenIn,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  looksLikeContact,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type LocalSlot,
} from '@pepper/contracts';
import { findClientsByNameIn, permissionScope } from '@pepper/core';
import { z } from 'zod';
import { daysOf, instantOf, localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { ReadTool, ToolScope } from '../tool.js';
import {
  bookingView,
  clientNames,
  DateArg,
  day,
  directoryOf,
  domainOptions,
  IdArg,
  localSlot,
  serviceName,
  staffName,
  TimeArg,
  when,
} from './shared.js';

// The read tools (ADR-0029): answers about the business from the domain, never the model's
// memory (LLM09). Each runs as the member, so staff get exactly what their screens show.

const SLOTS_SHOWN = 12;
const CLIENTS_SHOWN = 10;
const DAY_BOOKINGS_MAX = 100;

const ownOnly = (scope: ToolScope) =>
  permissionScope(scope.actor.context.role, 'bookings.read') !== 'all';

export const findAvailability: ReadTool = {
  kind: 'read',
  name: 'find_availability',
  version: 1,
  localTimes: true,
  guide: {
    use: 'Find free start times for a service, with one staff member or anyone who offers it, on a day or a few days.',
    avoid: [
      'to book (use create_booking with a time found here)',
      'to see what is already booked (use get_day)',
    ],
    returns:
      'free start times with the staff member, earliest first, and whether more exist. Offer them; never book one the member did not choose.',
    examples: [
      {
        say: 'When can Jess fit in a haircut on Friday?',
        args: { serviceId: { $any: true }, staffMemberId: { $any: true }, date: { $any: true } },
      },
      {
        say: 'Any time for a colour next week after 3?',
        args: { serviceId: { $any: true }, days: 7, notBefore: '15:00' },
      },
    ],
  },
  args: z.strictObject({
    serviceId: IdArg('service'),
    staffMemberId: IdArg('staff member').nullable().describe('null: anyone who offers it'),
    date: DateArg,
    days: z.number().int().min(1).max(7).nullable().describe('Days from `date`, 1–7; null: 1'),
    notBefore: TimeArg.nullable().describe('Earliest start on the first day; null: any'),
  }),
  async run(
    scope,
    args: {
      serviceId: string;
      staffMemberId: string | null;
      date: string;
      days: number | null;
      notBefore: string | null;
    },
  ) {
    const range = daysOf(scope.timeZone, args.date, args.days ?? 1);
    const from =
      args.notBefore === null ? range.from : instantOf(scope.timeZone, args.date, args.notBefore);
    const directory = await directoryOf(scope);
    const serviceId = ServiceIdSchema.parse(args.serviceId);
    const slots = await findAvailabilityIn(
      scope.tx,
      scope.actor,
      {
        serviceId,
        ...(args.staffMemberId !== null && {
          staffMemberId: StaffMemberIdSchema.parse(args.staffMemberId),
        }),
        from,
        to: range.to,
      },
      domainOptions(scope),
    );
    // With anyone: one per start time, so the list spreads over the day.
    const starts = new Set<string>();
    const shown: LocalSlot[] = [];
    for (const slot of slots) {
      if (starts.has(slot.startsAt)) continue;
      starts.add(slot.startsAt);
      shown.push(localSlot(scope, directory, slot));
    }
    const more = shown.length > SLOTS_SHOWN;
    const kept = shown.slice(0, SLOTS_SHOWN);
    const service = serviceName(directory, serviceId);
    const first = kept[0];
    return {
      summary:
        first === undefined
          ? `No free times for ${service} then. Try other days or anyone free.`
          : `${String(kept.length)}${more ? '+' : ''} free times for ${service}; the first is ${when(first.date, first.time)} with ${first.staffName}.`,
      data: { slots: kept, more },
      card:
        kept.length === 0
          ? null
          : { kind: 'slot_picker', reason: 'availability', serviceId, slots: kept },
    };
  },
};

export const findClients: ReadTool = {
  kind: 'read',
  name: 'find_clients',
  version: 1,
  localTimes: false,
  guide: {
    use: "Find the business's clients by name, to get the id every client action needs.",
    avoid: [
      'with an email address or phone number (search by name only)',
      'to pick one of several matches yourself (show them and ask the member which one)',
    ],
    returns:
      'up to 10 matches as id and short name (first name, last initial). Staff find only clients they have bookings with.',
    examples: [
      { say: 'Book Maria for a cut tomorrow at 10', args: { name: { $regex: '^maria' } } },
      { say: "Move Sarah's appointment", args: { name: { $regex: 'sarah' } } },
    ],
  },
  args: z.strictObject({
    name: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .refine((name) => !looksLikeContact(name), 'Search by name only')
      .describe('The name or part of it, as the member said it'),
  }),
  async run(scope, args: { name: string }) {
    const found = await findClientsByNameIn(scope.tx, scope.actor, {
      search: args.name,
      limit: CLIENTS_SHOWN + 1,
    });
    const matches = found
      .slice(0, CLIENTS_SHOWN)
      .map((client) => ({ clientId: client.id, name: shortClientName(client.name) }));
    const more = found.length > CLIENTS_SHOWN;
    const summary =
      matches.length === 0
        ? `No client matches that name${ownOnly(scope) ? ' among your own clients' : ''}. Ask for the spelling; never guess.`
        : matches.length === 1
          ? `Found ${matches[0]?.name ?? 'one client'}.`
          : `${String(matches.length)}${more ? '+' : ''} clients match: ask the member which one; never pick for them.`;
    return {
      summary,
      data: { matches, more },
      card: matches.length > 1 ? { kind: 'client_choice', clients: matches } : null,
    };
  },
};

export const getDay: ReadTool = {
  kind: 'read',
  name: 'get_day',
  version: 1,
  localTimes: true,
  guide: {
    use: "Read one day's schedule: its bookings (time, client, service, staff) and blocked time.",
    avoid: ['to find free times (use find_availability)'],
    returns: 'the day’s bookings by time and the blocked times. Staff see only their own bookings.',
    examples: [
      { say: "What's on today?", args: { date: { $any: true }, staffMemberId: null } },
      { say: 'How busy is Marco on Thursday?', args: { staffMemberId: { $any: true } } },
    ],
  },
  args: z.strictObject({
    date: DateArg,
    staffMemberId: IdArg('staff member').nullable().describe('null: everyone'),
  }),
  async run(scope, args: { date: string; staffMemberId: string | null }) {
    const range = daysOf(scope.timeZone, args.date);
    const staffId =
      args.staffMemberId === null ? undefined : StaffMemberIdSchema.parse(args.staffMemberId);
    const directory = await directoryOf(scope);
    const bookings = (
      await listBookingsIn(
        scope.tx,
        scope.actor,
        { ...range, ...(staffId !== undefined && { staffMemberId: staffId }) },
        { limit: DAY_BOOKINGS_MAX },
      )
    ).filter((booking) => booking.status !== 'cancelled');
    const names = await clientNames(
      scope,
      bookings.map((booking) => booking.clientId),
    );
    const views = bookings.map((booking) => bookingView(scope, directory, names, booking));
    const timeOff = await listTimeOffBetweenIn(
      scope.tx,
      scope.actor,
      { from: new Date(range.from), to: new Date(range.to) },
      staffId === undefined ? undefined : [staffId],
    );
    const clip = (instant: string, edge: string, bound: 'start' | 'end') =>
      bound === 'start'
        ? Date.parse(instant) < Date.parse(edge)
          ? '00:00'
          : localOf(scope.timeZone, instant).time
        : Date.parse(instant) > Date.parse(edge)
          ? '23:59'
          : localOf(scope.timeZone, instant).time;
    const blocked = timeOff.map((entry) => ({
      staffMemberId: entry.staffMemberId,
      staffName: staffName(directory, entry.staffMemberId),
      from: clip(entry.startsAt, range.from, 'start'),
      to: clip(entry.endsAt, range.to, 'end'),
    }));
    const scopeNote = ownOnly(scope) ? ' (your own bookings)' : '';
    return {
      summary: `${day(args.date)}: ${String(views.length)} booking${views.length === 1 ? '' : 's'}${scopeNote}, ${String(blocked.length)} blocked time${blocked.length === 1 ? '' : 's'}.`,
      data: { date: args.date, bookings: views, blocked },
      card: { kind: 'day', date: args.date, bookings: views, blocked },
    };
  },
};

export const getBooking: ReadTool = {
  kind: 'read',
  name: 'get_booking',
  version: 1,
  localTimes: false,
  guide: {
    use: 'Read one booking by its id: when, which client, service and staff member, and its status.',
    avoid: ['to search for a booking (use get_day or find_clients first)'],
    returns: 'the booking in the business’s local time.',
    examples: [
      { say: "Is Maria's booking still on?", args: { bookingId: { $any: true } } },
      { say: 'What time is that appointment?', args: { bookingId: { $any: true } } },
    ],
  },
  args: z.strictObject({ bookingId: IdArg('booking') }),
  async run(scope, args: { bookingId: string }) {
    const booking = await getBookingIn(
      scope.tx,
      scope.actor,
      BookingIdSchema.parse(args.bookingId),
    );
    const directory = await directoryOf(scope);
    const names = await clientNames(scope, [booking.clientId]);
    const view = bookingView(scope, directory, names, booking);
    return {
      summary: `${view.clientName}: ${view.serviceName} with ${view.staffName}, ${when(view.date, view.time)} (${view.status}).`,
      data: view,
      card: { kind: 'booking', booking: view },
    };
  },
};

export const listServicesAndStaff: ReadTool = {
  kind: 'read',
  name: 'list_services_and_staff',
  version: 1,
  localTimes: false,
  guide: {
    use: "List the business's services (with their length) and its staff members (with what each offers), to get their ids.",
    avoid: ['to find free times (use find_availability)'],
    returns:
      'active services and staff members with ids; `isYou` marks the member’s own staff member.',
    examples: [
      { say: 'Who does colour?', args: {} },
      { say: 'Book a beard trim with Marco', args: {} },
    ],
  },
  args: z.strictObject({}),
  async run(scope) {
    const directory = await directoryOf(scope);
    const services = [...directory.services.values()]
      .filter((service) => service.active)
      .map((service) => ({
        serviceId: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
      }));
    const staff = [...directory.staff.values()]
      .filter((member) => member.active)
      .map((member) => ({
        staffMemberId: member.id,
        name: member.displayName,
        serviceIds: member.serviceIds,
        isYou: member.userId === scope.actor.context.userId,
      }));
    return {
      summary: `${String(services.length)} services, ${String(staff.length)} staff members.`,
      data: { services, staff },
      card: null,
    };
  },
};
