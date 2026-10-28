'use client';

import { ClientSchema, type Client } from '@pepper/contracts';
import { Button, buttonStyle, Icon, Input, Sheet } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { normalizeContact } from '../../../lib/booking';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../booking/sheet';

/**
 * Adds a client (`POST /v1/clients`, then their profile) or edits one's name, email and phone
 * (`PUT /v1/clients/:id`). Owners and managers only; the api checks it again. On the kit (S42):
 * its Sheet and fields; `label` names the opener when the screen words it differently ("Add a
 * phone or email" on an empty profile).
 */
export function ClientEditor({
  client,
  label,
  open: shown,
  onOpenChange,
  returnFocus,
}: {
  client?: Client;
  label?: string;
  /** Opened from elsewhere too (the empty list's "Add your first client"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes on close when another button opened it (Sheet's `returnFocus`). */
  returnFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={client === undefined ? 'Add a client' : `Edit ${client.name}`}
      open={open}
      returnFocus={returnFocus}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        client === undefined ? (
          <button type="button" className={buttonStyle({ size: 'sm' })}>
            <Icon name="plus" />
            {label ?? 'Add client'}
          </button>
        ) : (
          <button type="button" className={buttonStyle({ variant: 'secondary', size: 'sm' })}>
            {label ?? 'Edit details'}
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
      <Input
        label="Name"
        name="name"
        required
        autoComplete="off"
        maxLength={120}
        defaultValue={client?.name ?? ''}
      />
      <Input
        label="Email (optional)"
        name="email"
        type="email"
        autoComplete="off"
        maxLength={254}
        defaultValue={client?.email ?? ''}
      />
      <Input
        label="Phone (optional)"
        hint="US numbers as you’d dial them; others with +."
        name="phone"
        type="tel"
        autoComplete="off"
        maxLength={20}
        defaultValue={client?.phone ?? ''}
      />
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <Button type="submit" busy={busy} block>
        {busy ? 'Saving…' : client === undefined ? 'Add client' : 'Save'}
      </Button>
    </form>
  );
}
