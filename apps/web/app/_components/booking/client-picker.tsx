'use client';

import { ClientSchema, ClientsResponseSchema, type Client } from '@pepper/contracts';
import { Avatar, Button, cx, FOCUS_RING, Input, List, Segmented } from '@pepper/ui';
import { useState, type SubmitEvent } from 'react';
import { normalizeContact } from '../../../lib/booking';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

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
      <div className="flex items-center gap-3 rounded-md bg-surface-2 px-4 py-3">
        <Avatar name={value.client.name} />
        <div className="min-w-0 flex-1">
          <p className="m-0 truncate type-body font-semibold text-ink" data-testid="chosen-client">
            {value.client.name}
          </p>
          <p className="m-0 truncate type-caption text-ink-2">{contactLine(value.client)}</p>
        </div>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => {
            onChange(null);
          }}
        >
          Change
        </Button>
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
    <List label="Clients found">
      {clients.map((client) => (
        <li key={client.id}>
          <button
            type="button"
            className={cx(
              'flex min-h-14 w-full items-center gap-3 rounded-sm bg-transparent px-2 py-3 text-left',
              'text-ink hover:bg-surface-2',
              FOCUS_RING,
            )}
            onClick={() => {
              onChoose(client);
            }}
          >
            <Avatar name={client.name} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate type-body font-semibold">{client.name}</span>
              <span className="truncate type-caption text-ink-2">{contactLine(client)}</span>
            </span>
          </button>
        </li>
      ))}
    </List>
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
        <Input
          label="Client’s email or phone"
          hint="Their full email or phone number, e.g. (555) 123-4567."
          name="contact"
          required
          autoComplete="off"
          inputMode="email"
          maxLength={254}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          busy={busy}
          className="justify-self-start"
        >
          Find client
        </Button>
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {found === null ? null : found.clients.length === 0 ? (
        <p className="m-0 type-body text-ink-2" role="status">
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
    <Segmented
      label="Client"
      value={mode}
      options={[
        { value: 'search', label: 'Find a client' },
        { value: 'add', label: 'New client' },
      ]}
      onValueChange={(next) => {
        setMode(next === 'add' ? 'add' : 'search');
        setError(null);
      }}
    />
  );

  return (
    <div className="grid gap-3">
      {tabs}
      {mode === 'search' ? (
        <form className="grid gap-2" onSubmit={(event) => void search(event)}>
          <Input label="Name or email" name="search" required autoComplete="off" maxLength={120} />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            busy={busy}
            className="justify-self-start"
          >
            Search
          </Button>
        </form>
      ) : (
        <form className="grid gap-2" onSubmit={(event) => void add(event)}>
          <Input label="Name" name="name" required autoComplete="off" maxLength={120} />
          <Input
            label="Email (optional)"
            name="email"
            type="email"
            autoComplete="off"
            maxLength={254}
          />
          <Input
            label="Phone (optional)"
            hint="US numbers as you’d dial them; others with +."
            name="phone"
            type="tel"
            autoComplete="off"
            maxLength={20}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            busy={busy}
            className="justify-self-start"
          >
            Add client
          </Button>
        </form>
      )}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {mode === 'search' && results !== null ? (
        results.length === 0 ? (
          <p className="m-0 type-body text-ink-2" role="status">
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
