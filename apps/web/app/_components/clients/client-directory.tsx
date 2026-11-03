'use client';

import { ClientsResponseSchema, type Client } from '@pepper/contracts';
import {
  Avatar,
  buttonStyle,
  cx,
  EmptyState,
  fieldStyle,
  IconButton,
  List,
  ListRow,
} from '@pepper/ui';
import Link from 'next/link';
import { useRef, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { fetchJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';
import { kitLink } from '../kit-link';

/** How many clients one search shows. */
const SEARCH_LIMIT = 50;

/**
 * The client list with a search by name or email (`GET /v1/clients`). The api decides whom
 * each role sees: owners and managers every client, staff the clients they have appointments
 * with (AC-W9-1). The search stays out of the page's URL. On the kit (S42): hairline rows with
 * initials, and an empty list that says what to do next (AC-X-7); `onAdd` opens the add sheet.
 * With `importId` (S49.2, AC-W1-29) it lists only the clients that import added, a search
 * staying inside them, and "Show everyone" leaves the filter.
 */
export function ClientDirectory({
  initial,
  staffView,
  onAdd,
  importId = null,
}: {
  initial: Client[];
  staffView: boolean;
  /** Owners and managers: opens "Add a client" (the empty list's action). */
  onAdd?: (() => void) | undefined;
  importId?: string | null;
}) {
  const [clients, setClients] = useState(initial);
  const searchField = useRef<HTMLInputElement>(null);
  const [searched, setSearched] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(text: string) {
    const query = new URLSearchParams({ limit: String(SEARCH_LIMIT) });
    if (text !== '') query.set('search', text);
    if (importId !== null) query.set('import', importId);
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
      {importId === null ? null : (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-2 py-1 pr-1 pl-4"
          data-testid="clients-import-filter"
        >
          <p className="m-0 type-body text-ink">New from your import</p>
          <Link href={ROUTES.clients} className={buttonStyle({ variant: 'quiet', size: 'sm' })}>
            Show everyone
          </Link>
        </div>
      )}
      <form
        role="search"
        className="flex gap-2"
        onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
          event.preventDefault();
          void search(formText(event.currentTarget, 'search').trim());
        }}
      >
        <label className="sr-only" htmlFor="client-search">
          Search clients by name or email
        </label>
        <input
          ref={searchField}
          id="client-search"
          name="search"
          type="search"
          autoComplete="off"
          maxLength={120}
          placeholder="Name or email"
          className={cx(fieldStyle, 'min-h-12 min-w-0 flex-1')}
        />
        <IconButton
          type="submit"
          icon="search"
          label="Search"
          variant="secondary"
          disabled={busy}
          className="size-12"
        />
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {clients.length === 0 ? (
        <div role="status">
          {searched === null && importId !== null ? (
            <EmptyState
              icon="clients"
              title="No new clients from this import"
              body="Everyone in the file was already here, or the import was undone."
              action={{ label: 'Show everyone', href: ROUTES.clients, renderLink: kitLink }}
            />
          ) : searched !== null ? (
            <EmptyState
              icon="search"
              title={`No clients match “${searched}”`}
              body="Check the spelling, or search by email instead."
              action={{
                label: importId === null ? 'Show everyone' : 'Clear the search',
                onClick: () => {
                  // The field shows what the list shows: empty again.
                  if (searchField.current !== null) searchField.current.value = '';
                  void search('');
                },
              }}
            />
          ) : staffView || onAdd === undefined ? (
            <EmptyState
              icon="clients"
              title="No clients here yet"
              body="Clients you have appointments with show here. Book someone and they’re added."
              action={{ label: 'Open the calendar', href: ROUTES.calendar, renderLink: kitLink }}
            />
          ) : (
            <EmptyState
              icon="clients"
              title="No clients yet"
              body="Add your regulars once, and booking them takes a tap. Anyone you book is added too."
              action={{ label: 'Add your first client', onClick: onAdd }}
            />
          )}
        </div>
      ) : (
        <List label="Clients" className="rounded-lg bg-surface px-4">
          {clients.map((client) => (
            <ListRow
              key={client.id}
              href={`${ROUTES.clients}/${client.id}`}
              renderLink={kitLink}
              leading={<Avatar name={client.name} size="sm" />}
              title={client.name}
              meta={
                [client.email, client.phone].filter((part) => part !== null).join(' · ') ||
                'No contact details yet'
              }
            />
          ))}
        </List>
      )}
      {clients.length === SEARCH_LIMIT ? (
        <p className="m-0 type-caption text-ink-2">
          Showing the first {SEARCH_LIMIT}; search to narrow it.
        </p>
      ) : null}
    </div>
  );
}
