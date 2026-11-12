import {
  BookingsResponseSchema,
  ClientIdSchema,
  MemoryFactsResponseSchema,
  ClientSchema,
  ClientTextsSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
  type Booking,
  type RecordSource,
} from '@pepper/contracts';
import { Avatar, Badge, buttonStyle, cx, DetailTable, FOCUS_RING, Icon } from '@pepper/ui';
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
import { birthdayLabel } from '../../../../lib/clients';
import { localDateIn, splitVisits, visitRanges } from '../../../../lib/setup';
import { NewBooking } from '../../../_components/booking/new-booking';
import { ClientActions } from '../../../_components/clients/client-actions';
import { ClientEditor } from '../../../_components/clients/client-editor';
import { ClientTextsSection } from '../../../_components/clients/client-texts';
import { ClientMemory } from '../../../_components/memory/client-memory';
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
 * A client's profile (S16): how to reach them, what Pepper knows about them and their visit
 * notes (S32), their coming and recent visits (62 days each way), Book, and, for owners and
 * managers, editing their details (tags and birthday too, S50, AC-W1-32) and, at the foot,
 * merging and deleting them (ADR-0051, AC-W1-30, AC-W1-31); where their texts stand, with the
 * words they agreed to (S61.2, AC-X-66). `?book=1` opens Book at once,
 * with `service` and `staff` chosen when bookable ("Book again", AC-W1-33). Staff reach only their own clients and see only their own
 * visits with them (AC-W9-1, decided by the api). On the kit (S42): initials and the name as
 * the title, then quiet sections of hairline rows; the empty ones say what to do next.
 */
export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.read')) redirect(ROUTES.home);
  const id = ClientIdSchema.safeParse((await params).clientId);
  if (!id.success) notFound();
  const wanted = await searchParams;
  const one = (value: string | string[] | undefined) =>
    typeof value === 'string' ? value : undefined;

  const now = Date.now();
  const ranges = visitRanges(now);
  const bookingsOf = (range: { from: string; to: string }) =>
    currentJson(
      `/v1/bookings?${new URLSearchParams({ ...range, clientId: id.data }).toString()}`,
      BookingsResponseSchema,
    );
  const readsNotes = current.permissions.includes('client_notes.read');
  const [client, past, upcoming, services, staff, memory, texts] = await Promise.all([
    currentJson(`/v1/clients/${id.data}`, ClientSchema),
    bookingsOf(ranges.past),
    bookingsOf(ranges.upcoming),
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson('/v1/staff', StaffResponseSchema),
    readsNotes
      ? currentJson(
          `/v1/memory/facts?${new URLSearchParams({ clientId: id.data }).toString()}`,
          MemoryFactsResponseSchema,
        )
      : Promise.resolve(null),
    currentJson(`/v1/clients/${id.data}/texts`, ClientTextsSchema),
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

  const manages = current.permissions.includes('clients.manage');
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        href={ROUTES.clients}
        className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-3 self-start')}
      >
        <Icon name="left" />
        Clients
      </Link>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar name={client.name} size="lg" />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="m-0 type-display [overflow-wrap:anywhere]">{client.name}</h1>
            <p className="m-0 type-label text-ink-2">{SOURCES[client.source]}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {manages ? <ClientEditor client={client} /> : null}
          {books ? (
            <NewBooking
              setup={setup}
              date={localDateIn(timeZone, now)}
              client={{ client }}
              defaultOpen={one(wanted['book']) === '1'}
              preset={{ serviceId: one(wanted['service']), staffMemberId: one(wanted['staff']) }}
            />
          ) : null}
        </div>
      </header>
      {client.tags.length === 0 ? null : (
        // Tags as quiet chips: words the owner gave, not a status (DESIGN.md §2).
        <ul
          className="-mt-3 m-0 flex list-none flex-wrap gap-1.5 p-0"
          aria-label="Tags"
          data-testid="client-tags"
        >
          {client.tags.map((tag, index) => (
            <li
              // By position too: nothing but the import promises tags without repeats.
              key={`${String(index)}-${tag}`}
              className="max-w-full rounded-pill bg-surface-2 px-2.5 py-0.5 type-caption text-ink-2 [overflow-wrap:anywhere]"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}

      <section aria-labelledby="client-contact" className="flex flex-col gap-3">
        <h2 id="client-contact" className="m-0 type-heading">
          Contact
        </h2>
        {client.email === null && client.phone === null ? (
          <div className="flex flex-col items-start gap-3">
            <p className="m-0 type-body text-ink-2">
              No email or phone yet{manages ? ': add one and I can send their reminders.' : '.'}
            </p>
            {manages ? <ClientEditor client={client} label="Add a phone or email" /> : null}
          </div>
        ) : null}
        {client.email === null && client.phone === null && client.birthday === null ? null : (
          <div className="rounded-lg bg-surface px-4" data-testid="client-contact">
            <DetailTable
              rows={[
                ...(client.email === null
                  ? []
                  : [
                      {
                        label: 'Email',
                        value: <ContactLink href={`mailto:${client.email}`} text={client.email} />,
                      },
                    ]),
                ...(client.phone === null
                  ? []
                  : [
                      {
                        label: 'Phone',
                        value: <ContactLink href={`tel:${client.phone}`} text={client.phone} />,
                      },
                    ]),
                ...(client.birthday === null
                  ? []
                  : [
                      {
                        label: 'Birthday',
                        value: (
                          <span className="tabular-nums" data-testid="client-birthday">
                            {birthdayLabel(client.birthday)}
                          </span>
                        ),
                      },
                    ]),
              ]}
            />
          </div>
        )}
      </section>

      {texts === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t check {client.name}’s texts. Try again in a moment.
        </p>
      ) : (
        <ClientTextsSection
          clientId={id.data}
          clientName={client.name}
          initial={texts}
          timeZone={timeZone}
          hasPhone={client.phone !== null}
        />
      )}

      {!readsNotes ? null : memory === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read what I know about {client.name}. Try again in a moment.
        </p>
      ) : (
        <ClientMemory
          clientId={id.data}
          clientName={client.name}
          initialFacts={memory.facts}
          timeZone={timeZone}
          canChange={current.permissions.includes('client_notes.manage')}
        />
      )}

      {past === null || upcoming === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load all of {client.name}’s visits. Try again in a moment.
        </p>
      ) : null}

      <section aria-labelledby="client-upcoming" className="flex flex-col gap-3">
        <h2 id="client-upcoming" className="m-0 type-heading">
          Coming up
        </h2>
        {visits.upcoming.length === 0 ? (
          <p className="m-0 type-body text-ink-2">
            Nothing booked in the next two months.
            {books ? ' Tap Book to find them a time.' : null}
          </p>
        ) : (
          <VisitList
            testId="upcoming-visits"
            items={visits.upcoming.map((booking) => ({ id: booking.id, ...describe(booking) }))}
          />
        )}
      </section>

      <section aria-labelledby="client-past" className="flex flex-col gap-3">
        <h2 id="client-past" className="m-0 type-heading">
          Recent visits
        </h2>
        {visits.past.length === 0 ? (
          <p className="m-0 type-body text-ink-2">No visits in the last two months.</p>
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
      </section>

      {manages ? <ClientActions client={client} /> : null}
    </div>
  );
}

/** An email or phone on its own line: a 44 px tap target (D3), the text wrapping if long. */
function ContactLink({ href, text }: { href: string; text: string }) {
  return (
    <a
      href={href}
      className={cx(
        'inline-flex min-h-11 items-center font-semibold text-brand [overflow-wrap:anywhere] underline-offset-2',
        FOCUS_RING,
      )}
    >
      {text}
    </a>
  );
}

/** Visits as quiet hairline rows: the time first, then what and with whom, a status if any. */
function VisitList({
  items,
  testId,
}: {
  items: { id: string; when: string; what: string; status?: string | undefined; muted?: boolean }[];
  testId: string;
}) {
  return (
    <ul
      className="m-0 flex list-none flex-col divide-y divide-line rounded-lg bg-surface px-4 py-0"
      data-testid={testId}
    >
      {items.map((item) => (
        <li
          key={item.id}
          className={cx(
            'flex min-h-14 items-center justify-between gap-3 py-3',
            item.muted === true && 'opacity-70',
          )}
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 type-body font-semibold text-ink tabular-nums">{item.when}</p>
            <p className="m-0 type-caption text-ink-2">{item.what}</p>
          </div>
          {item.status === undefined ? null : <Badge>{item.status}</Badge>}
        </li>
      ))}
    </ul>
  );
}
