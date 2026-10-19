'use client';

import { ClientsResponseSchema, type Client } from '@pepper/contracts';
import { buttonClass, Icon } from '@pepper/ui';
import Link from 'next/link';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { fetchJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../booking/sheet';

/** How many clients one search shows. */
const SEARCH_LIMIT = 50;

/**
 * The client list with a search by name or email (`GET /v1/clients`). The api decides whom
 * each role sees: owners and managers every client, staff the clients they have appointments
 * with (AC-W9-1). The search stays out of the page's URL.
 */
export function ClientDirectory({ initial, staffView }: { initial: Client[]; staffView: boolean }) {
  const [clients, setClients] = useState(initial);
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(text: string) {
    const query = new URLSearchParams({ limit: String(SEARCH_LIMIT) });
    if (text !== '') query.set('search', text);
    setBusy(true);
    const answer = await fetchJson(`/v1/clients?${query.toString()}`, ClientsResponseSchema);
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    if (!answer.ok) return;
    setClients(answer.data.clients);
    setSearched(text === '' ? null : text);
  }

  return (
    <div className="grid gap-3">
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
          void search(formText(event.currentTarget, 'search').trim());
        }}
      >
        <label className="visually-hidden" htmlFor="client-search">
          Search clients by name or email
        </label>
        <input
          id="client-search"
          name="search"
          type="search"
          autoComplete="off"
          maxLength={120}
          placeholder="Name or email"
        />
        <button
          type="submit"
          disabled={busy}
          aria-label="Search"
          className={buttonClass({ variant: 'secondary', className: 'w-11 shrink-0 px-0' })}
        >
          <Icon name="search" />
        </button>
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {clients.length === 0 ? (
        <p className="m-0 text-ink-2" role="status">
          {searched !== null
            ? `No clients match “${searched}”.`
            : staffView
              ? 'Clients you have appointments with show here.'
              : 'No clients yet. Add one, or book someone from the calendar.'}
        </p>
      ) : (
        <ul
          className="m-0 grid list-none divide-y divide-line rounded-lg border border-line bg-surface p-0"
          data-testid="clients"
        >
          {clients.map((client) => (
            <li key={client.id}>
              <Link
                href={`${ROUTES.clients}/${client.id}`}
                className="grid gap-0.5 px-4 py-3 font-normal text-ink no-underline hover:bg-surface-2"
                data-testid="client"
              >
                <span className="font-bold">{client.name}</span>
                <span className="truncate text-sm text-ink-2">
                  {[client.email, client.phone].filter((part) => part !== null).join(' · ') ||
                    'No contact details'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {clients.length === SEARCH_LIMIT ? (
        <p className="m-0 text-sm text-ink-2">
          Showing the first {SEARCH_LIMIT}; search to narrow it.
        </p>
      ) : null}
    </div>
  );
}
