'use client';

import { ClientSchema, type Client } from '@pepper/contracts';
import { Button, buttonStyle, Icon, Input, Select, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { normalizeContact } from '../../../lib/booking';
import { birthdayFromForm, MONTHS, tagsFromText, tagsText } from '../../../lib/clients';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

/**
 * Adds a client (`POST /v1/clients`, then their profile) or edits one's name, email, phone,
 * tags and birthday (`PUT /v1/clients/:id`; tags and birthday from S50, AC-W1-32). Owners and managers only; the api checks it again. On the kit (S42):
 * its Sheet and fields, Save in the sheet's footer (S42.2); `label` names the opener when the screen words it differently ("Add a
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
  const formId = useId();
  const birthday = client?.birthday ?? null;

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = formText(form, 'email').trim();
    const phone = formText(form, 'phone').trim();
    const tags = tagsFromText(formText(form, 'tags'));
    const birthday = birthdayFromForm(
      formText(form, 'birthdayMonth'),
      formText(form, 'birthdayDay'),
      formText(form, 'birthdayYear'),
    );
    if (tags === null) {
      setError('Up to 20 tags, each up to 40 letters, separated by commas.');
      return;
    }
    if (birthday === 'invalid') {
      setError('Check the birthday: a month and a day it has (the year is optional).');
      return;
    }
    const body = {
      name: formText(form, 'name'),
      email: email === '' ? null : email,
      phone: phone === '' ? null : normalizeContact(phone),
      tags,
      birthday,
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
            ? 'Check the name, email, phone (other countries need their + code), tags and birthday.'
            : answer.message,
      );
      return;
    }
    onDone();
    if (client === undefined) router.push(`${ROUTES.clients}/${saved.data.id}`);
    else router.refresh();
  }

  return (
    <form id={formId} className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
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
      <Input
        label="Tags (optional)"
        hint="Separate them with commas, e.g. VIP, color client."
        name="tags"
        autoComplete="off"
        maxLength={900}
        defaultValue={tagsText(client?.tags ?? [])}
      />
      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-2 p-0 type-label font-semibold text-ink">Birthday (optional)</legend>
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)] gap-2">
          <Select
            label="Month"
            name="birthdayMonth"
            defaultValue={birthday === null ? '' : String(birthday.month)}
            options={[
              { value: '', label: 'Month' },
              ...MONTHS.map((month, index) => ({ value: String(index + 1), label: month })),
            ]}
          />
          <Input
            label="Day"
            name="birthdayDay"
            inputMode="numeric"
            autoComplete="off"
            maxLength={2}
            defaultValue={birthday === null ? '' : String(birthday.day)}
          />
          <Input
            label="Year"
            name="birthdayYear"
            inputMode="numeric"
            autoComplete="off"
            maxLength={4}
            defaultValue={birthday?.year === null || birthday === null ? '' : String(birthday.year)}
          />
        </div>
      </fieldset>
      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Button type="submit" form={formId} busy={busy} block size="lg">
          {busy ? 'Saving…' : client === undefined ? 'Add client' : 'Save'}
        </Button>
      </SheetFooter>
    </form>
  );
}
