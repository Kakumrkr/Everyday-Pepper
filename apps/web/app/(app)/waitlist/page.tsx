import {
  ClientsResponseSchema,
  ServicesResponseSchema,
  StaffResponseSchema,
  WaitlistOffersResponseSchema,
  WaitlistResponseSchema,
} from '@pepper/contracts';
import { LegacyCard } from '@pepper/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import {
  ENTRY_STATUS_LABELS,
  OFFER_STATUS_LABELS,
  offersBySlot,
  windowLabel,
} from '../../../lib/waitlist';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';

/** A small status label: done (green), waiting (amber) or neither. */
function statusClass(tone: 'ok' | 'wait' | 'neutral'): string {
  const colours = {
    ok: 'bg-ok-soft text-ok',
    wait: 'bg-wait-soft text-wait',
    neutral: 'bg-surface-2 text-ink-2',
  };
  return `rounded-full px-3 py-1 text-sm font-semibold ${colours[tone]}`;
}
export const metadata: Metadata = { title: 'Waitlist · Pepper' };

/**
 * The waitlist (S37, ADR-0041): who is waiting for what, and the freed times Pepper offered,
 * with each offer's state (waiting for an answer, booked, someone else took it, expired).
 * Staff see their own staff member's entries and offers (the api decides). Offers waiting for
 * an OK are on Home, under "Needs your OK".
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

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="m-0 font-display text-2xl font-bold">Waitlist</h1>
        <p className="m-0 text-ink-2">
          When a booking is cancelled or moved, I offer the time to the best matches here. The first
          to claim it books it.
        </p>
      </header>
      {entries === null || offers === null ? (
        <p role="alert" className="rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load the waitlist. Try again in a moment.
        </p>
      ) : (
        <>
          <section aria-labelledby="waiting" className="flex flex-col gap-2">
            <h2 id="waiting" className="m-0 font-display text-lg font-bold">
              Waiting ({entries.entries.length})
            </h2>
            {entries.entries.length === 0 ? (
              <p className="m-0 text-ink-2">Nobody is waiting right now.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {entries.entries.map((entry) => (
                  <li key={entry.id}>
                    <LegacyCard className="flex flex-col gap-1 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">
                          {clientName.get(entry.clientId) ?? 'A client'}
                        </span>
                        <span
                          className={statusClass(entry.status === 'offered' ? 'wait' : 'neutral')}
                        >
                          {ENTRY_STATUS_LABELS[entry.status]}
                        </span>
                      </div>
                      <span className="text-ink-2">
                        {serviceName.get(entry.serviceId) ?? 'A service'} with{' '}
                        {entry.staffMemberId === null
                          ? 'anyone'
                          : (staffName.get(entry.staffMemberId) ?? 'a staff member')}
                      </span>
                      <span className="text-sm text-ink-2">
                        {entry.windows.map(windowLabel).join(' · ')}
                      </span>
                    </LegacyCard>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="offers" className="flex flex-col gap-2">
            <h2 id="offers" className="m-0 font-display text-lg font-bold">
              Offers
            </h2>
            {offers.offers.length === 0 ? (
              <p className="m-0 text-ink-2">No freed times offered yet.</p>
            ) : (
              offersBySlot(offers.offers, timeZone).map((group) => (
                <LegacyCard key={group.key} className="flex flex-col gap-2 p-3">
                  <span className="font-semibold">
                    {group.label} with {staffName.get(group.staffMemberId) ?? 'a staff member'}
                  </span>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0">
                    {group.offers.map((offer) => (
                      <li
                        key={offer.id}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span>
                          {offer.rank}. {clientName.get(offer.clientId) ?? 'A client'}
                        </span>
                        <span
                          className={statusClass(
                            offer.status === 'claimed'
                              ? 'ok'
                              : offer.status === 'offered'
                                ? 'wait'
                                : 'neutral',
                          )}
                        >
                          {OFFER_STATUS_LABELS[offer.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                </LegacyCard>
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
