'use client';

import { ClientSchema, ClientsResponseSchema, type Client } from '@pepper/contracts';
import { Avatar, Button, cx, FOCUS_RING, Input, List, Segmented } from '@pepper/ui';
import { useState, type SubmitEvent } from 'react';
import {
  normalizeContact,
  walkInFrom,
  walkInPrefill,
  walkInProblem,
  type WalkIn,
} from '../../../lib/booking';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

/** The client chosen, with the exact contact staff found them by (ADR-0020). */
export interface ChosenClient {
  client: Client;
  contact?: string;
}

/** Whom the booking is for: a client who exists, or a walk-in staff add with it (S50.2). */
export type PickedClient = ChosenClient | { walkIn: WalkIn };

/**
 * Chooses the client. Owners and managers search by name or email and may add a new client;
 * staff find a client by their exact email or phone (they cannot list clients), or add a
 * walk-in, who is created with the booking and is then theirs (ADR-0052).
 */
export function ClientPicker({
  managesClients,
  value,
  onChange,
}: {
  managesClients: boolean;
  value: PickedClient | null;
  onChange: (chosen: PickedClient | null) => void;
}) {
  if (value !== null) {
    const card =
      'walkIn' in value
        ? {
            name: value.walkIn.name,
            caption: [
              'New client, added with this booking',
              ...[value.walkIn.email, value.walkIn.phone].filter((part) => part !== null),
            ].join(' · '),
          }
        : { name: value.client.name, caption: contactLine(value.client) };
    return (
      <ChosenCard
        {...card}
        onChange={() => {
          onChange(null);
        }}
      />
    );
  }
  return managesClients ? (
    <SearchClients onChoose={onChange} />
  ) : (
    <StaffClient onChoose={onChange} />
  );
}

/** Staff: find a client by exact contact, or add a walk-in with this booking. */
function StaffClient({ onChoose }: { onChoose: (chosen: PickedClient) => void }) {
  const [mode, setMode] = useState<'find' | 'new'>('find');
  const [prefill, setPrefill] = useState({ email: '', phone: '' });
  return (
    <div className="grid gap-3">
      <Segmented
        label="Client"
        value={mode}
        options={[
          { value: 'find', label: 'Find a client' },
          { value: 'new', label: 'New client' },
        ]}
        onValueChange={(next) => {
          setMode(next === 'new' ? 'new' : 'find');
        }}
      />
      {mode === 'find' ? (
        <FindByContact
          onChoose={onChoose}
          onNew={(contact) => {
            setPrefill(walkInPrefill(contact));
            setMode('new');
          }}
        />
      ) : (
        <WalkInForm prefill={prefill} onChoose={onChoose} />
      )}
    </div>
  );
}

/** Staff: a walk-in's name, and an email or phone if they give one. */
function WalkInForm({
  prefill,
  onChoose,
}: {
  prefill: { email: string; phone: string };
  onChoose: (chosen: PickedClient) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  function use(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const form = event.currentTarget;
    const walkIn = walkInFrom({
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      phone: formText(form, 'phone'),
    });
    const wrong = walkInProblem(walkIn);
    setProblem(wrong);
    if (wrong === null) onChoose({ walkIn });
  }
  return (
    <form className="grid gap-2" onSubmit={use}>
      <p className="m-0 type-body text-ink-2">
        They’re added with this booking and become your client.
      </p>
      <Input label="Name" name="name" required autoComplete="off" maxLength={120} />
      <Input
        label="Email (optional)"
        name="email"
        type="email"
        autoComplete="off"
        maxLength={254}
        defaultValue={prefill.email}
      />
      <Input
        label="Phone (optional)"
        hint="US numbers as you’d dial them; others with +."
        name="phone"
        type="tel"
        autoComplete="off"
        maxLength={20}
        defaultValue={prefill.phone}
      />
      {problem === null ? null : <Notice tone="error">{problem}</Notice>}
      <Button type="submit" variant="secondary" size="sm" className="justify-self-start">
        Use new client
      </Button>
    </form>
  );
}

/** The client chosen, with "Change" to choose again. */
function ChosenCard({
  name,
  caption,
  onChange,
}: {
  name: string;
  caption: string;
  onChange: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-surface-2 px-4 py-3">
      <Avatar name={name} />
      <div className="min-w-0 flex-1">
        <p className="m-0 truncate type-body font-semibold text-ink" data-testid="chosen-client">
          {name}
        </p>
        <p className="m-0 truncate type-caption text-ink-2">{caption}</p>
      </div>
      <Button variant="quiet" size="sm" onClick={onChange}>
        Change
      </Button>
    </div>
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
function FindByContact({
  onChoose,
  onNew,
}: {
  onChoose: (chosen: ChosenClient) => void;
  onNew: (contact: string) => void;
}) {
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
        <div className="grid gap-2" role="status">
          <p className="m-0 type-body text-ink-2">No client with that email or phone.</p>
          <Button
            variant="secondary"
            size="sm"
            className="justify-self-start"
            onClick={() => {
              onNew(found.contact);
            }}
          >
            Add as a new client
          </Button>
        </div>
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
