import { listServicesIn, listStaffIn } from '@pepper/appointments';
import {
  ClientIdSchema,
  LocalDateSchema,
  LocalTimeSchema,
  StaffMemberIdSchema,
  type AvailableSlot,
  type Booking,
  type BookingView,
  type ChangeSide,
  type ClientId,
  type LocalSlot,
  type Service,
  type StaffMember,
  type StaffMemberId,
  type UserId,
} from '@pepper/contracts';
import { clientNamesIn } from '@pepper/core';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { ToolScope } from '../tool.js';

// Shared by the catalog: argument pieces with their descriptions (the model reads them), and
// the views every answer is built from: ids, local times, the names a member sees on screen and
// a client's short name, never a contact.

export const IdArg = (what: string) => z.uuid().describe(`The ${what}'s id, from a lookup tool`);
export const DateArg = LocalDateSchema.describe(
  "A date in the business's time zone, YYYY-MM-DD, read from the date table",
);
export const TimeArg = LocalTimeSchema.describe(
  "A time in the business's time zone, 24-hour HH:MM",
);
export const EmailClientArg = z
  .boolean()
  .nullable()
  .describe(
    'Email the client about it: true or false if the member said so, else null (the usual: yes)',
  );

/** The domain services' options from the tool's dependencies. */
export function domainOptions(scope: ToolScope) {
  const { clock, templateRuleDefaults } = scope.deps;
  return { clock, ...(templateRuleDefaults !== undefined && { templateRuleDefaults }) };
}

/** The business's services and staff members, by id. */
export interface Directory {
  services: Map<string, Service>;
  staff: Map<string, StaffMember>;
}

export async function directoryOf(scope: ToolScope): Promise<Directory> {
  const [services, staff] = [
    await listServicesIn(scope.tx, scope.actor),
    await listStaffIn(scope.tx, scope.actor),
  ];
  return {
    services: new Map(services.map((service) => [service.id, service])),
    staff: new Map(staff.map((member) => [member.id, member])),
  };
}

/** The staff member linked to the member's own login, if any. */
export function ownStaffMember(scope: ToolScope, directory: Directory): StaffMember | undefined {
  return [...directory.staff.values()].find(
    (member) => member.userId === scope.actor.context.userId,
  );
}

/** Whose record a staff member's booking or time off is: their login (ADR-0017). */
export function staffLogin(directory: Directory, staffMemberId: StaffMemberId): UserId | null {
  return directory.staff.get(staffMemberId)?.userId ?? null;
}

export function staffName(directory: Directory, staffMemberId: string): string {
  return directory.staff.get(staffMemberId)?.displayName ?? 'Someone';
}

export function serviceName(directory: Directory, serviceId: string): string {
  return directory.services.get(serviceId)?.name ?? 'A service';
}

/** The short names of these bookings' clients the member may see. */
export async function clientNames(
  scope: ToolScope,
  clientIds: readonly ClientId[],
): Promise<Map<ClientId, string>> {
  const names = await clientNamesIn(scope.tx, scope.actor, clientIds);
  return new Map([...names].map(([id, name]) => [id, shortClientName(name)]));
}

export function bookingView(
  scope: ToolScope,
  directory: Directory,
  names: Map<ClientId, string>,
  booking: Booking,
): BookingView {
  const start = localOf(scope.timeZone, booking.startsAt);
  return {
    bookingId: booking.id,
    date: start.date,
    time: start.time,
    endTime: localOf(scope.timeZone, booking.endsAt).time,
    clientId: booking.clientId,
    clientName: names.get(booking.clientId) ?? 'Client',
    serviceId: booking.serviceId,
    serviceName: serviceName(directory, booking.serviceId),
    staffMemberId: booking.staffMemberId,
    staffName: staffName(directory, booking.staffMemberId),
    status: booking.status,
  };
}

/** A booking as one side of a change (`withId: false` for one the change creates). */
export function bookingSide(view: BookingView, options: { withId: boolean }): ChangeSide {
  const { bookingId, ...rest } = view;
  return options.withId ? { bookingId, ...rest } : rest;
}

/** "Tue 2026-11-03". */
export function day(date: string): string {
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  });
  return `${weekday} ${date}`;
}

/** "Tue 2026-11-03 at 10:00". */
export function when(date: string, time: string): string {
  return `${day(date)} at ${time}`;
}

export function localSlot(scope: ToolScope, directory: Directory, slot: AvailableSlot): LocalSlot {
  const start = localOf(scope.timeZone, slot.startsAt);
  return {
    date: start.date,
    time: start.time,
    staffMemberId: StaffMemberIdSchema.parse(slot.staffMemberId),
    staffName: staffName(directory, slot.staffMemberId),
  };
}

export const clientIdOf = (value: string): ClientId => ClientIdSchema.parse(value);
