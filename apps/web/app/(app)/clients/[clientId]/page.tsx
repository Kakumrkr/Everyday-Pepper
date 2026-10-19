import {
  BookingsResponseSchema,
  ClientIdSchema,
  ClientSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
  type Booking,
  type RecordSource,
} from '@pepper/contracts';
import { Card, cx } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import {
  bookableStaff,
  bookingAbilities,
  dateTimeLabel,
  STATUS_LABELS,
  type BookingSetup,
} from '../../../../lib/booking';
import { localDateIn, splitVisits, visitRanges } from '../../../../lib/setup';
import { NewBooking } from '../../../_components/booking/new-booking';
import { ClientEditor } from '../../../_components/clients/client-editor';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Client · Pepper' };

const SOURCES: Record<RecordSource, string> = {
  team: 'Added by the team',
  ai: 'Added by Pepper',
  booking_page: 'Booked online',
  import: 'Imported',
};

/**
 * A client's profile (S16): how to reach them, their coming and recent visits (62 days each
 * way), Book, and, for owners and managers, editing their details. Staff reach only their own
 * clients and see only their own visits with them (AC-W9-1, decided by the api).
 */
export default async function ClientPage({ params }: { params: Promise<{ clientId: string }> }) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.read')) redirect(ROUTES.home);
  const id = ClientIdSchema.safeParse((await params).clientId);
  if (!id.success) notFound();

  const now = Date.now();
  const ranges = visitRanges(now);
  const bookingsOf = (range: { from: string; to: string }) =>
    currentJson(
      `/v1/bookings?${new URLSearchParams({ ...range, clientId: id.data }).toString()}`,
      BookingsResponseSchema,
    );
  const [client, past, upcoming, services, staff] = await Promise.all([
    currentJson(`/v1/clients/${id.data}`, ClientSchema),
    bookingsOf(ranges.past),
    bookingsOf(ranges.upcoming),
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson('/v1/staff', StaffResponseSchema),
  ]);
  // Unknown, another business's, or (staff) not theirs: the api answers 404 alike.
  if (client === null) notFound();

  const { timeZone } = current.business;
  const visits = splitVisits([...(past?.bookings ?? []), ...(upcoming?.bookings ?? [])], now);
  const serviceNames = new Map((services?.services ?? []).map((s) => [s.id, s.name]));
  const staffNames = new Map((staff?.staff ?? []).map((m) => [m.id, m.displayName]));
  const userId = account.me.user.id;
  const abilities = bookingAbilities(current.permissions, current.role);
  const setup: BookingSetup = {
    timeZone,
    userId,
    abilities,
    services: (services?.services ?? []).filter((service) => service.active),
    staff: staff?.staff ?? [],
  };
  const books =
    abilities.books &&
    bookableStaff(setup.staff, { userId, ownOnly: abilities.ownStaffOnly }).length > 0;
  const describe = (booking: Booking) => ({
    when: dateTimeLabel(timeZone, booking.startsAt),
    what: `${serviceNames.get(booking.serviceId) ?? 'Appointment'} with ${
      staffNames.get(booking.staffMemberId) ?? 'someone'
    }`,
  });

  return (
    <div className="mx-auto max-w-2xl">
      <p className="m-0 mb-1">
        <Link href={ROUTES.clients}>Clients</Link>
      </p>
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="m-0 font-display text-2xl font-bold [overflow-wrap:anywhere]">
            {client.name}
          </h1>
          <p className="m-0 text-ink-2">{SOURCES[client.source]}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {current.permissions.includes('clients.manage') ? <ClientEditor client={client} /> : null}
          {books ? (
            <NewBooking setup={setup} date={localDateIn(timeZone, now)} client={{ client }} />
          ) : null}
        </div>
      </header>

      <div className="grid gap-4">
        <Card>
          <h2 className="m-0 mb-2 font-display text-lg font-bold">Contact</h2>
          {client.email === null && client.phone === null ? (
            <p className="m-0 text-ink-2">No email or phone yet.</p>
          ) : (
            <ul className="m-0 grid list-none gap-1 p-0" data-testid="client-contact">
              {client.email === null ? null : (
                <li>
                  <a href={`mailto:${client.email}`}>{client.email}</a>
                </li>
              )}
              {client.phone === null ? null : (
                <li>
                  <a href={`tel:${client.phone}`}>{client.phone}</a>
                </li>
              )}
            </ul>
          )}
        </Card>

        {past === null || upcoming === null ? (
          <p role="alert" className="m-0 rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
            I couldn’t load all of {client.name}’s visits. Try again in a moment.
          </p>
        ) : null}

        <Card>
          <h2 className="m-0 mb-2 font-display text-lg font-bold">Coming up</h2>
          {visits.upcoming.length === 0 ? (
            <p className="m-0 text-ink-2">Nothing booked in the next two months.</p>
          ) : (
            <VisitList
              testId="upcoming-visits"
              items={visits.upcoming.map((booking) => ({ id: booking.id, ...describe(booking) }))}
            />
          )}
        </Card>

        <Card>
          <h2 className="m-0 mb-2 font-display text-lg font-bold">Recent visits</h2>
          {visits.past.length === 0 ? (
            <p className="m-0 text-ink-2">No visits in the last two months.</p>
          ) : (
            <VisitList
              testId="past-visits"
              items={visits.past.map((booking) => ({
                id: booking.id,
                ...describe(booking),
                status: booking.status === 'confirmed' ? undefined : STATUS_LABELS[booking.status],
                muted: booking.status === 'cancelled' || booking.status === 'no_show',
              }))}
            />
          )}
        </Card>
      </div>
    </div>
  );
}

function VisitList({
  items,
  testId,
}: {
  items: { id: string; when: string; what: string; status?: string | undefined; muted?: boolean }[];
  testId: string;
}) {
  return (
    <ul className="m-0 grid list-none divide-y divide-line p-0" data-testid={testId}>
      {items.map((item) => (
        <li
          key={item.id}
          className={cx(
            'flex items-start justify-between gap-3 py-2',
            item.muted === true && 'text-ink-2',
          )}
        >
          <div className="min-w-0">
            <p className="m-0 font-semibold">{item.when}</p>
            <p className="m-0 text-sm text-ink-2">{item.what}</p>
          </div>
          {item.status === undefined ? null : (
            <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2">
              {item.status}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
