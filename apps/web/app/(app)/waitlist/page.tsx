import {
  ClientsResponseSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
  WaitlistOffersResponseSchema,
  WaitlistResponseSchema,
} from '@pepper/contracts';
import { Badge, buttonStyle, EmptyState, type BadgeTone } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import {
  ENTRY_STATUS_LABELS,
  OFFER_STATUS_LABELS,
  offersBySlot,
  windowLabel,
} from '../../../lib/waitlist';
import { kitLink } from '../../_components/kit-link';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Waitlist · Pepper' };

/**
 * The waitlist (S37, ADR-0041): who is waiting for what, and the freed times Pepper offered,
 * with each offer's state (waiting for an answer, booked, someone else took it, expired).
 * Staff see their own staff member's entries and offers (the api decides). Offers waiting for
 * an OK are on Home, under "Needs your OK". On the kit since S42.3 (AC-X-10): quiet hairline
 * rows with status badges; an empty list offers the chat, where Pepper adds people, and no
 * offers yet points to the calendar (one primary action on the screen, DESIGN D4).
 */
export default async function WaitlistPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('bookings.read')) redirect(ROUTES.home);
  const [entries, offers, clients, services, staff] = await Promise.all([
    currentJson('/v1/waitlist', WaitlistResponseSchema),
    currentJson('/v1/waitlist/offers', WaitlistOffersResponseSchema),
    currentJson('/v1/clients?limit=200', ClientsResponseSchema),
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson('/v1/staff', StaffResponseSchema),
  ]);
  const clientName = new Map<string, string>(clients?.clients.map((c) => [c.id, c.name]) ?? []);
  const serviceName = new Map<string, string>(services?.services.map((s) => [s.id, s.name]) ?? []);
  const staffName = new Map<string, string>(staff?.staff.map((s) => [s.id, s.displayName]) ?? []);
  const { timeZone } = current.business;

  const offerTone = (status: string): BadgeTone =>
    status === 'claimed' ? 'ok' : status === 'offered' ? 'warn' : 'neutral';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Waitlist</h1>
        <p className="m-0 type-body text-ink-2">
          When a booking is cancelled or moved, I offer the time to the best matches here. The first
          to claim it books it.
        </p>
      </header>
      {entries === null || offers === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load the waitlist. Try again in a moment.
        </p>
      ) : (
        <>
          <section aria-labelledby="waiting" className="flex flex-col gap-3">
            <h2 id="waiting" className="m-0 type-heading">
              Waiting ({entries.entries.length})
            </h2>
            {entries.entries.length === 0 ? (
              <EmptyState
                icon="waitlist"
                title="Nobody is waiting right now."
                body="Tell me in chat, like “Put Maria on the waitlist for a haircut on Saturday”. When a time frees up, I offer it to the best match."
                action={{ label: 'Add someone in chat', href: ROUTES.chat, renderLink: kitLink }}
              />
            ) : (
              <ul className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4">
                {entries.entries.map((entry) => (
                  <li key={entry.id} className="flex min-h-14 items-start gap-3 py-3">
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="type-body font-semibold text-ink">
                        {clientName.get(entry.clientId) ?? 'A client'}
                      </span>
                      <span className="type-caption text-ink-2">
                        {serviceName.get(entry.serviceId) ?? 'A service'} with{' '}
                        {entry.staffMemberId === null
                          ? 'anyone'
                          : (staffName.get(entry.staffMemberId) ?? 'a staff member')}
                      </span>
                      <span className="type-caption text-ink-2 tabular-nums">
                        {entry.windows.map(windowLabel).join(' · ')}
                      </span>
                    </div>
                    <Badge tone={entry.status === 'offered' ? 'warn' : 'neutral'}>
                      {ENTRY_STATUS_LABELS[entry.status]}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="offers" className="flex flex-col gap-3">
            <h2 id="offers" className="m-0 type-heading">
              Offers
            </h2>
            {offers.offers.length === 0 ? (
              <div className="flex flex-col items-start gap-3 rounded-lg bg-surface-2 px-4 py-4">
                <p className="m-0 type-body text-ink-2">
                  No freed times offered yet. When a booking is cancelled or moved, I offer the time
                  here.
                </p>
                <Link
                  href={ROUTES.calendar}
                  className={buttonStyle({ variant: 'secondary', size: 'sm' })}
                >
                  Open the calendar
                </Link>
              </div>
            ) : (
              offersBySlot(offers.offers, timeZone).map((group) => (
                <div key={group.key} className="flex flex-col rounded-lg bg-surface px-4 py-3">
                  <span className="type-body font-semibold text-ink tabular-nums">
                    {group.label} with {staffName.get(group.staffMemberId) ?? 'a staff member'}
                  </span>
                  <ul className="m-0 list-none divide-y divide-line p-0">
                    {group.offers.map((offer) => (
                      <li
                        key={offer.id}
                        className="flex min-h-11 flex-wrap items-center justify-between gap-2 py-2"
                      >
                        <span className="type-body text-ink">
                          {offer.rank}. {clientName.get(offer.clientId) ?? 'A client'}
                        </span>
                        <Badge tone={offerTone(offer.status)}>
                          {OFFER_STATUS_LABELS[offer.status]}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
