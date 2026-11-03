'use client';

import {
  ClientRecordsSchema,
  ClientSchema,
  ClientsResponseSchema,
  type Client,
  type ClientRecords,
} from '@pepper/contracts';
import { Button, buttonStyle, cx, fieldStyle, IconButton, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { deleteSentence, mergeSentence, upcomingSentence } from '../../../lib/clients';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

// Merge and delete on a client's profile (S50, ADR-0051, AC-W1-30, AC-W1-31): owners and
// managers only (the page shows them only with `clients.manage`; the api decides again). Each
// sheet reads the counts first, says in words what will happen, and asks once.

const SEARCH_LIMIT = 20;

/** "Merge with…" and "Delete client", as quiet actions at the foot of the profile. */
export function ClientActions({ client }: { client: Client }) {
  return (
    <section aria-labelledby="client-manage" className="flex flex-col gap-3">
      <h2 id="client-manage" className="m-0 type-heading">
        Tidy up
      </h2>
      <p className="m-0 type-body text-ink-2">
        Two records for the same person? Merge them. Asked to be forgotten? Delete them.
      </p>
      <div className="flex flex-wrap gap-2">
        <MergeSheet client={client} />
        <DeleteSheet client={client} />
      </div>
    </section>
  );
}

function MergeSheet({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={`Merge ${client.name} with…`}
      description="Pick the other record. Everything moves here, to this client."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonStyle({ variant: 'secondary', size: 'sm' })}>
          Merge with…
        </button>
      }
    >
      <MergeForm
        key={key}
        client={client}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

function MergeForm({ client, onDone }: { client: Client; onDone: () => void }) {
  const router = useRouter();
  const [found, setFound] = useState<Client[] | null>(null);
  const [other, setOther] = useState<{ client: Client; records: ClientRecords } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(text: string) {
    if (text === '') return;
    setBusy(true);
    const query = new URLSearchParams({ search: text, limit: String(SEARCH_LIMIT) });
    const answer = await fetchJson(`/v1/clients?${query.toString()}`, ClientsResponseSchema);
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    if (answer.ok) setFound(answer.data.clients.filter((c) => c.id !== client.id));
  }

  async function choose(chosen: Client) {
    setBusy(true);
    const answer = await fetchJson(`/v1/clients/${chosen.id}/records`, ClientRecordsSchema);
    setBusy(false);
    setError(answer.ok ? null : answer.message);
    if (answer.ok) setOther({ client: chosen, records: answer.data });
  }

  async function merge() {
    if (other === null) return;
    setBusy(true);
    const answer = await sendJson('POST', `/v1/clients/${client.id}/merge`, {
      otherClientId: other.client.id,
    });
    setBusy(false);
    if (!answer.ok || !ClientSchema.safeParse(answer.data).success) {
      setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
      return;
    }
    onDone();
    router.refresh();
  }

  if (other !== null) {
    return (
      <div className="grid gap-4" data-testid="merge-confirm">
        <p className="m-0 type-body text-ink">
          {mergeSentence(other.client.name, client.name, other.records)}
        </p>
        <SheetFooter>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          <Button block size="lg" busy={busy} onClick={() => void merge()}>
            {busy ? 'Merging…' : `Merge into ${client.name}`}
          </Button>
          <Button
            block
            variant="quiet"
            onClick={() => {
              setOther(null);
              setError(null);
            }}
          >
            Pick someone else
          </Button>
        </SheetFooter>
      </div>
    );
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
        <label className="sr-only" htmlFor="merge-search">
          Find the other record by name or email
        </label>
        <input
          id="merge-search"
          name="search"
          type="search"
          autoComplete="off"
          maxLength={120}
          placeholder="Name or email"
          className={cx(fieldStyle, 'min-h-12 min-w-0 flex-1')}
        />
        <IconButton type="submit" icon="search" label="Search" variant="secondary" />
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {found === null ? null : found.length === 0 ? (
        <p className="m-0 type-body text-ink-2">No one else by that name or email.</p>
      ) : (
        <ul
          className="m-0 flex list-none flex-col divide-y divide-line rounded-lg bg-surface px-4 py-0"
          aria-label="Pick the other record"
        >
          {found.map((candidate) => (
            <li
              key={candidate.id}
              className="flex min-h-14 items-center justify-between gap-3 py-2"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="type-body font-semibold text-ink [overflow-wrap:anywhere]">
                  {candidate.name}
                </span>
                {candidate.email === null && candidate.phone === null ? null : (
                  <span className="type-caption text-ink-2 [overflow-wrap:anywhere]">
                    {candidate.email ?? candidate.phone}
                  </span>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                // The visible word first, so a voice command "Pick" finds it.
                aria-label={`Pick ${candidate.name}`}
                onClick={() => void choose(candidate)}
              >
                Pick
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DeleteSheet({ client }: { client: Client }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={`Delete ${client.name}?`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonStyle({ variant: 'quiet', size: 'sm' })}>
          Delete client
        </button>
      }
    >
      <DeleteForm
        key={key}
        client={client}
        onCancel={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

function DeleteForm({ client, onCancel }: { client: Client; onCancel: () => void }) {
  const router = useRouter();
  const [records, setRecords] = useState<ClientRecords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The counts as the sheet opens (each opening mounts a fresh form).
  useEffect(() => {
    let stopped = false;
    void fetchJson(`/v1/clients/${client.id}/records`, ClientRecordsSchema).then((answer) => {
      if (stopped) return;
      if (answer.ok) setRecords(answer.data);
      else setError(answer.message);
    });
    return () => {
      stopped = true;
    };
  }, [client.id]);

  async function remove() {
    setBusy(true);
    const answer = await sendJson('DELETE', `/v1/clients/${client.id}`, undefined);
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    router.push(ROUTES.clients);
    router.refresh();
  }

  if (records === null) {
    return error === null ? (
      <p className="m-0 type-body text-ink-2">Checking what {client.name} has with you…</p>
    ) : (
      <Notice tone="error">{error}</Notice>
    );
  }
  const sentence = deleteSentence(client.name, records);
  return (
    <div className="grid gap-4" data-testid="delete-confirm">
      <p className="m-0 type-body text-ink">{sentence ?? upcomingSentence(client.name, records)}</p>
      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        {sentence === null ? (
          <Button block size="lg" variant="secondary" onClick={onCancel}>
            OK
          </Button>
        ) : (
          <>
            <Button block size="lg" variant="danger" busy={busy} onClick={() => void remove()}>
              {busy ? 'Deleting…' : `Delete ${client.name}`}
            </Button>
            <Button block variant="quiet" onClick={onCancel}>
              Keep them
            </Button>
          </>
        )}
      </SheetFooter>
    </div>
  );
}
