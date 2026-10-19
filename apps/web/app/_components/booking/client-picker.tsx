'use client';

import { ClientSchema, ClientsResponseSchema, type Client } from '@pepper/contracts';
import { buttonClass, cx } from '@pepper/ui';
import { useState, type SubmitEvent } from 'react';
import { normalizeContact } from '../../../lib/booking';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Field, Notice } from './sheet';

/** The client chosen, with the exact contact staff found them by (ADR-0020). */
export interface ChosenClient {
  client: Client;
  contact?: string;
}

/**
 * Chooses the client. Owners and managers search by name or email and may add a new client;
 * staff find a client by their exact email or phone (they cannot list or add clients).
 */
export function ClientPicker({
  managesClients,
  value,
  onChange,
}: {
  managesClients: boolean;
  value: ChosenClient | null;
  onChange: (chosen: ChosenClient | null) => void;
}) {
  if (value !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-4 py-3">
        <div className="min-w-0">
          <p className="m-0 truncate font-bold" data-testid="chosen-client">
            {value.client.name}
          </p>
          <p className="m-0 truncate text-sm text-ink-2">{contactLine(value.client)}</p>
        </div>
        <button
          type="button"
          className={buttonClass({ variant: 'quiet', size: 'sm' })}
          onClick={() => {
            onChange(null);
          }}
        >
          Change
        </button>
      </div>
    );
  }
  return managesClients ? (
    <SearchClients onChoose={onChange} />
  ) : (
    <FindByContact onChoose={onChange} />
  );
}

function contactLine(client: Client): string {
  return (
    [client.email, client.phone].filter((part) => part !== null).join(' · ') || 'No contact details'
  );
}

function ClientList({
  clients,
  onChoose,
}: {
  clients: Client[];
  onChoose: (client: Client) => void;
}) {
  return (
    <ul className="m-0 grid list-none gap-2 p-0" aria-label="Clients found">
      {clients.map((client) => (
        <li key={client.id}>
          <button
            type="button"
            className="grid w-full gap-0.5 rounded-md border border-line bg-surface px-4 py-2 text-left text-ink hover:bg-surface-2"
            onClick={() => {
              onChoose(client);
            }}
          >
            <span className="font-bold">{client.name}</span>
            <span className="text-sm font-normal text-ink-2">{contactLine(client)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Staff: one exact email or phone, never a part of one. */
function FindByContact({ onChoose }: { onChoose: (chosen: ChosenClient) => void }) {
  const [found, setFound] = useState<{ contact: string; clients: Client[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function find(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const contact = normalizeContact(formText(event.currentTarget, 'contact'));
    setBusy(true);
    const answer = await sendJson('POST', '/v1/clients/lookup', { contact });
    setBusy(false);
    const parsed = answer.ok ? ClientsResponseSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setFound(null);
      setError(
        answer.ok
          ? 'Something went wrong. Try again.'
          : answer.status === 400
            ? 'Type the client’s full email address or phone number.'
            : answer.message,
      );
      return;
    }
    setError(null);
    setFound({ contact, clients: parsed.data.clients });
  }

  return (
    <div className="grid gap-3">
      <form className="grid gap-2" onSubmit={(event) => void find(event)}>
        <Field
          label="Client’s email or phone"
          hint="Their full email or phone number, e.g. (555) 123-4567."
        >
          <input name="contact" required autoComplete="off" inputMode="email" maxLength={254} />
        </Field>
        <button
          type="submit"
          disabled={busy}
          className={buttonClass({ variant: 'secondary', className: 'justify-self-start' })}
        >
          Find client
        </button>
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {found === null ? null : found.clients.length === 0 ? (
        <p className="m-0 text-ink-2" role="status">
          No client with that email or phone. An owner or manager can add them.
        </p>
      ) : (
        <ClientList
          clients={found.clients}
          onChoose={(client) => {
            onChoose({ client, contact: found.contact });
          }}
        />
      )}
    </div>
  );
}

/** Owners and managers: search by name or email, or add a new client. */
function SearchClients({ onChoose }: { onChoose: (chosen: ChosenClient) => void }) {
  const [mode, setMode] = useState<'search' | 'add'>('search');
  const [results, setResults] = useState<Client[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const query = new URLSearchParams({
      search: formText(event.currentTarget, 'search'),
      limit: '8',
    });
    setBusy(true);
    const answer = await fetchJson(`/v1/clients?${query.toString()}`, ClientsResponseSchema);
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    setResults(answer.ok ? answer.data.clients : null);
  }

  async function add(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email');
    const phone = formText(form, 'phone');
    setBusy(true);
    const answer = await sendJson('POST', '/v1/clients', {
      name: formText(form, 'name'),
      email: email === '' ? null : email,
      phone: phone === '' ? null : normalizeContact(phone),
    });
    setBusy(false);
    const client = answer.ok ? ClientSchema.safeParse(answer.data) : null;
    if (client?.success === true) {
      onChoose({ client: client.data });
      return;
    }
    setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
  }

  const tabs = (
    <div className="flex gap-2" role="group" aria-label="Client">
      {(['search', 'add'] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          aria-pressed={mode === tab}
          className={cx(
            'min-h-11 rounded-full border px-4 text-sm font-semibold',
            mode === tab
              ? 'border-brand bg-brand-soft text-ink'
              : 'border-line bg-surface text-ink-2',
          )}
          onClick={() => {
            setMode(tab);
            setError(null);
          }}
        >
          {tab === 'search' ? 'Find a client' : 'New client'}
        </button>
      ))}
    </div>
  );

  return (
    <div className="grid gap-3">
      {tabs}
      {mode === 'search' ? (
        <form className="grid gap-2" onSubmit={(event) => void search(event)}>
          <Field label="Name or email">
            <input name="search" required autoComplete="off" maxLength={120} />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className={buttonClass({ variant: 'secondary', className: 'justify-self-start' })}
          >
            Search
          </button>
        </form>
      ) : (
        <form className="grid gap-2" onSubmit={(event) => void add(event)}>
          <Field label="Name">
            <input name="name" required autoComplete="off" maxLength={120} />
          </Field>
          <Field label="Email (optional)">
            <input name="email" type="email" autoComplete="off" maxLength={254} />
          </Field>
          <Field label="Phone (optional)" hint="US numbers as you’d dial them; others with +.">
            <input name="phone" type="tel" autoComplete="off" maxLength={20} />
          </Field>
          <button
            type="submit"
            disabled={busy}
            className={buttonClass({ variant: 'secondary', className: 'justify-self-start' })}
          >
            Add client
          </button>
        </form>
      )}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {mode === 'search' && results !== null ? (
        results.length === 0 ? (
          <p className="m-0 text-ink-2" role="status">
            No clients match. Add them as a new client.
          </p>
        ) : (
          <ClientList
            clients={results}
            onChoose={(client) => {
              onChoose({ client });
            }}
          />
        )
      ) : null}
    </div>
  );
}
