import {
  findAvailabilityIn,
  getBookingIn,
  listBookingsIn,
  listClientBookingsIn,
  listTimeOffBetweenIn,
  StaffMemberNotFoundError,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  ClientIdSchema,
  looksLikeContact,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type ClientId,
  type LocalSlot,
  type TrustJson,
} from '@pepper/contracts';
import { findClientsByNameIn, permissionScope } from '@pepper/core';
import { z } from 'zod';
import { daysOf, instantOf, localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { ReadTool, ToolScope } from '../tool.js';
import { lastVisitOf, recallFor, refsOf } from './recall.js';
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
  type Directory,
} from './shared.js';

// The read tools (ADR-0029): answers about the business from the domain, never the model's
// memory (LLM09). Each runs as the member, so staff get exactly what their screens show.

const SLOTS_SHOWN = 12;
const CLIENTS_SHOWN = 10;
const DAY_BOOKINGS_MAX = 100;
const CLIENT_UPCOMING_SHOWN = 5;
const CLIENT_RECENT_SHOWN = 3;
/** Clients whose memory comes with a name search (more matches: the member picks first). */
const CLIENTS_WITH_MEMORY = 3;

/** What the business remembers about these clients: their facts and last visit (S30). */
async function clientMemory(
  scope: ToolScope,
  clientIds: readonly ClientId[],
  known?: Directory,
): Promise<Map<ClientId, Record<string, TrustJson>>> {
  if (clientIds.length === 0) return new Map();
  const recall = await recallFor(scope, {
    subjects: clientIds.map((id) => ({ type: 'client' as const, id })),
    lastVisitsOf: clientIds,
  });
  if (recall.facts.size === 0 && recall.lastVisits.size === 0) return new Map();
  const directory = known ?? (await directoryOf(scope));
  return new Map(
    clientIds.map((id) => {
      const memory = refsOf(recall, { type: 'client', id });
      const lastVisit = lastVisitOf(scope, directory, recall, id);
      return [
        id,
        {
          ...(memory !== undefined && { memory }),
          ...(lastVisit !== undefined && { lastVisit }),
        },
      ];
    }),
  );
}

const ownOnly = (scope: ToolScope) =>
  permissionScope(scope.actor.context.role, 'bookings.read') !== 'all';

export const findAvailability: ReadTool = {
  kind: 'read',
  name: 'find_availability',
  // 2 (S33): "is she free at 10?" goes to get_day; the example's `notBefore` is one day's.
  version: 2,
  localTimes: true,
  guide: {
    use: 'Find free start times for a service, with one staff member or anyone who offers it, on a day or a few days.',
    avoid: [
      'to book (use create_booking with a time found here)',
      'to see what is already booked (use get_day)',
      'to check whether someone is free at one time on one day, without a service (read that day with get_day and answer; never ask which service)',
    ],
    returns:
      'free start times with the staff member, earliest first, and whether more exist. Offer them; book one only when the member chose it or asked you to find a time and book it.',
    examples: [
      {
        say: 'When can Jess fit in a haircut on Friday?',
        args: { serviceId: { $any: true }, staffMemberId: { $any: true }, date: { $any: true } },
      },
      {
        say: 'Any time for a colour on Friday after 3?',
        args: { serviceId: { $any: true }, date: { $any: true }, notBefore: '15:00' },
      },
    ],
  },
  args: z.strictObject({
    serviceId: IdArg('service'),
    staffMemberId: IdArg('staff member').nullable().describe('null: anyone who offers it'),
    date: DateArg,
    days: z.number().int().min(1).max(7).nullable().describe('Days from `date`, 1–7; null: 1'),
    notBefore: TimeArg.nullable().describe(
      'Earliest start on the first day only (later days start at opening); null: any',
    ),
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
  // 2 (S30): what the business remembers comes with up to 3 matches.
  version: 2,
  localTimes: false,
  guide: {
    use: "Find the business's clients by name, to get the id every client action needs.",
    avoid: [
      'with an email address or phone number (search by name only)',
      'to pick one of several matches yourself (show them and ask the member which one)',
    ],
    returns:
      'up to 10 matches as id and short name (first name, last initial), and for up to 3 what the business remembers (memory) and their last noted visit (lastVisit). Staff find only clients they have bookings with.',
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
    const shown = found.slice(0, CLIENTS_SHOWN);
    const memory =
      shown.length <= CLIENTS_WITH_MEMORY
        ? await clientMemory(
            scope,
            shown.map((client) => client.id),
          )
        : new Map<ClientId, Record<string, TrustJson>>();
    const matches = shown.map((client) => ({
      clientId: client.id,
      name: shortClientName(client.name),
    }));
    const more = found.length > CLIENTS_SHOWN;
    const summary =
      matches.length === 0
        ? `No client matches that name${ownOnly(scope) ? ' among your own clients' : ''}. Ask for the spelling; never guess.`
        : matches.length === 1
          ? `Found ${matches[0]?.name ?? 'one client'}.`
          : `${String(matches.length)}${more ? '+' : ''} clients match: ask the member which one; never pick for them.`;
    return {
      summary,
      data: {
        matches: matches.map((match) => ({ ...match, ...memory.get(match.clientId) })),
        more,
      },
      card: matches.length > 1 ? { kind: 'client_choice', clients: matches } : null,
    };
  },
};

export const getDay: ReadTool = {
  kind: 'read',
  name: 'get_day',
  // 2 (S26b): blocked times carry their id, for unblock_time. The guide (S30): "is she free at
  // 10?" without a service.
  version: 2,
  localTimes: true,
  guide: {
    use: "Read one day's schedule: its bookings (time, client, service, staff) and blocked time. It also answers whether someone is free at a time, without knowing a service.",
    avoid: ['to find free times for a service (use find_availability)'],
    returns:
      'the day’s bookings by time and the blocked times with their ids (for unblock_time). Staff see only their own bookings.',
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
    // Another business's (or a made-up) staff member is not found, as everywhere else.
    if (staffId !== undefined && !directory.staff.has(staffId)) {
      throw new StaffMemberNotFoundError();
    }
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
      timeOffId: entry.id,
      staffMemberId: entry.staffMemberId,
      staffName: staffName(directory, entry.staffMemberId),
      from: clip(entry.startsAt, range.from, 'start'),
      to: clip(entry.endsAt, range.to, 'end'),
    }));
    const scopeNote = ownOnly(scope) ? ' (your own bookings)' : '';
    return {
      summary: `${day(args.date)}: ${String(views.length)} booking${views.length === 1 ? '' : 's'}${scopeNote}, ${String(blocked.length)} blocked time${blocked.length === 1 ? '' : 's'}.`,
      data: { date: args.date, bookings: views, blocked },
      card: {
        kind: 'day',
        date: args.date,
        bookings: views,
        blocked: blocked.map(({ staffMemberId, staffName: name, from, to }) => ({
          staffMemberId,
          staffName: name,
          from,
          to,
        })),
      },
    };
  },
};

export const getBooking: ReadTool = {
  kind: 'read',
  name: 'get_booking',
  // 2 (S30): the visit's notes and the client's memory come with it.
  version: 2,
  localTimes: false,
  guide: {
    use: 'Read one booking by its id: when, which client, service and staff member, and its status.',
    avoid: ['to search for a booking (use get_day or find_clients first)'],
    returns:
      'the booking in the business’s local time, with its visit notes and what the business remembers about the client, service and staff member.',
    examples: [
      {
        say: "Is Maria's booking still on?",
        args: { bookingId: { $any: true } },
        evalSkip:
          'needs a booking id from earlier in the conversation; asked first, find_client_bookings is the right tool (S27)',
      },
      {
        say: 'What time is that appointment?',
        args: { bookingId: { $any: true } },
        evalSkip: 'refers to a booking named earlier in the conversation (S27)',
      },
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
    const subjects = {
      visitNotes: { type: 'booking' as const, id: booking.id },
      clientMemory: { type: 'client' as const, id: booking.clientId },
      serviceMemory: { type: 'service' as const, id: booking.serviceId },
      staffMemory: { type: 'staff' as const, id: booking.staffMemberId },
    };
    const recall = await recallFor(scope, {
      subjects: Object.values(subjects),
      lastVisitsOf: [booking.clientId],
    });
    const memory = Object.fromEntries(
      Object.entries(subjects).flatMap(([name, subject]) => {
        const refs = refsOf(recall, subject);
        return refs === undefined ? [] : [[name, refs]];
      }),
    );
    const lastVisit = lastVisitOf(scope, directory, recall, booking.clientId);
    return {
      summary: `${view.clientName}: ${view.serviceName} with ${view.staffName}, ${when(view.date, view.time)} (${view.status}).`,
      data: {
        ...view,
        ...memory,
        ...(lastVisit !== undefined && { lastVisit }),
      },
      card: { kind: 'booking', booking: view },
    };
  },
};

export const findClientBookings: ReadTool = {
  kind: 'read',
  name: 'find_client_bookings',
  // 2 (S30): the client's memory and last noted visit come with it.
  version: 2,
  localTimes: false,
  guide: {
    use: "Read one client's next appointments and last visits by the client's id: when they are next in, when they were last here.",
    avoid: [
      'with a name (use find_clients first for the id)',
      'to see everyone on a day (use get_day)',
    ],
    returns:
      'up to 5 upcoming bookings (not cancelled), earliest first, and the last 3 (with their status: done, no-show, cancelled), latest first, with what the business remembers about the client and their last noted visit. Staff see only their own bookings with the client.',
    examples: [
      { say: "When is Maria's next appointment?", args: { clientId: { $any: true } } },
      { say: 'When was Sarah last in?', args: { clientId: { $any: true } } },
    ],
  },
  args: z.strictObject({ clientId: IdArg('client') }),
  async run(scope, args: { clientId: string }) {
    const clientId = ClientIdSchema.parse(args.clientId);
    const { upcoming, recent } = await listClientBookingsIn(scope.tx, scope.actor, clientId, {
      now: scope.now,
      upcoming: CLIENT_UPCOMING_SHOWN,
      recent: CLIENT_RECENT_SHOWN,
    });
    const directory = await directoryOf(scope);
    const names = await clientNames(scope, [clientId]);
    const view = (booking: (typeof upcoming)[number]) =>
      bookingView(scope, directory, names, booking);
    const next = upcoming.map(view);
    const last = recent.map(view);
    const name = names.get(clientId) ?? 'This client';
    const [first] = next;
    const [latest] = last;
    const scopeNote = ownOnly(scope) ? ' with you' : '';
    const nextPart =
      first === undefined
        ? `no upcoming bookings${scopeNote}`
        : `next ${when(first.date, first.time)} (${first.serviceName} with ${first.staffName})`;
    const lastPart =
      latest === undefined
        ? 'no earlier visits'
        : `last ${when(latest.date, latest.time)} (${latest.status})`;
    const memory = (await clientMemory(scope, [clientId], directory)).get(clientId);
    return {
      summary: `${name}: ${nextPart}; ${lastPart}.`,
      data: { clientId, clientName: name, upcoming: next, recent: last, ...memory },
      card: first === undefined ? null : { kind: 'booking', booking: first },
    };
  },
};

export const listServicesAndStaff: ReadTool = {
  kind: 'read',
  name: 'list_services_and_staff',
  // 2 (S30): what the business remembers about each comes with it.
  version: 2,
  localTimes: false,
  guide: {
    use: "List the business's services (with their length) and its staff members (with what each offers), to get their ids.",
    avoid: ['to find free times (use find_availability)'],
    returns:
      'active services and staff members with ids and what the business remembers about each; `isYou` marks the member’s own staff member.',
    examples: [
      { say: 'Who does colour?', args: {} },
      { say: 'Book a beard trim with Marco', args: {} },
    ],
  },
  args: z.strictObject({}),
  async run(scope) {
    const directory = await directoryOf(scope);
    const active = {
      services: [...directory.services.values()].filter((service) => service.active),
      staff: [...directory.staff.values()].filter((member) => member.active),
    };
    const recall = await recallFor(scope, {
      subjects: [
        ...active.services.map((service) => ({ type: 'service' as const, id: service.id })),
        ...active.staff.map((member) => ({ type: 'staff' as const, id: member.id })),
      ],
    });
    const services = active.services.map((service) => {
      const memory = refsOf(recall, { type: 'service', id: service.id });
      return {
        serviceId: service.id,
        name: service.name,
        durationMinutes: service.durationMinutes,
        ...(memory !== undefined && { memory }),
      };
    });
    const staff = active.staff.map((member) => {
      const memory = refsOf(recall, { type: 'staff', id: member.id });
      return {
        staffMemberId: member.id,
        name: member.displayName,
        serviceIds: member.serviceIds,
        isYou: member.userId === scope.actor.context.userId,
        ...(memory !== undefined && { memory }),
      };
    });
    return {
      summary: `${String(services.length)} services, ${String(staff.length)} staff members.`,
      data: { services, staff },
      card: null,
    };
  },
};
