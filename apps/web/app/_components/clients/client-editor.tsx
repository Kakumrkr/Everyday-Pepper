'use client';

import { ClientSchema, type Client } from '@pepper/contracts';
import { buttonClass, Icon } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { normalizeContact } from '../../../lib/booking';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Field, Notice, Sheet } from '../booking/sheet';

/**
 * Adds a client (`POST /v1/clients`, then their profile) or edits one's name, email and phone
 * (`PUT /v1/clients/:id`). Owners and managers only; the api checks it again.
 */
export function ClientEditor({ client }: { client?: Client }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={client === undefined ? 'Add a client' : `Edit ${client.name}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        client === undefined ? (
          <button type="button" className={buttonClass({ size: 'sm' })}>
            <Icon name="plus" />
            Add client
          </button>
        ) : (
          <button type="button" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            Edit details
          </button>
        )
      }
    >
      <ClientForm
        key={key}
        client={client}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

function ClientForm({ client, onDone }: { client: Client | undefined; onDone: () => void }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email').trim();
    const phone = formText(form, 'phone').trim();
    const body = {
      name: formText(form, 'name'),
      email: email === '' ? null : email,
      phone: phone === '' ? null : normalizeContact(phone),
    };
    setBusy(true);
    const answer =
      client === undefined
        ? await sendJson('POST', '/v1/clients', body)
        : await sendJson('PUT', `/v1/clients/${client.id}`, body);
    setBusy(false);
    const saved = answer.ok ? ClientSchema.safeParse(answer.data) : null;
    if (saved?.success !== true) {
      setError(
        answer.ok
          ? 'Something went wrong. Try again.'
          : answer.status === 400
            ? 'Check the name, email and phone (other countries need their + code).'
            : answer.message,
      );
      return;
    }
    onDone();
    if (client === undefined) router.push(`${ROUTES.clients}/${saved.data.id}`);
    else router.refresh();
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Field label="Name">
        <input
          name="name"
          required
          autoComplete="off"
          maxLength={120}
          defaultValue={client?.name ?? ''}
        />
      </Field>
      <Field label="Email (optional)">
        <input
          name="email"
          type="email"
          autoComplete="off"
          maxLength={254}
          defaultValue={client?.email ?? ''}
        />
      </Field>
      <Field label="Phone (optional)" hint="US numbers as you’d dial them; others with +.">
        <input
          name="phone"
          type="tel"
          autoComplete="off"
          maxLength={20}
          defaultValue={client?.phone ?? ''}
        />
      </Field>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass({ className: 'w-full' })}>
        {busy ? 'Saving…' : client === undefined ? 'Add client' : 'Save'}
      </button>
    </form>
  );
}
