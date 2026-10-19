'use client';

import { ServiceSchema, type Service } from '@pepper/contracts';
import { buttonClass, Icon } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { centsFromText, textFromCents } from '../../../lib/setup';
import { Field, Notice, Sheet } from '../booking/sheet';

/**
 * Adds a service to the menu (`POST /v1/services`) or edits one (`PUT /v1/services/:id`, all
 * fields). Owners and managers only; the api checks it again.
 */
export function ServiceEditor({
  service,
  categories,
}: {
  /** The service to edit; none adds a new one. */
  service?: Service;
  /** Categories in use, offered as suggestions. */
  categories: string[];
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title={service === undefined ? 'Add a service' : `Edit ${service.name}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        service === undefined ? (
          <button type="button" className={buttonClass({ size: 'sm' })}>
            <Icon name="plus" />
            Add service
          </button>
        ) : (
          <button
            type="button"
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
            aria-label={`Edit ${service.name}`}
          >
            Edit
          </button>
        )
      }
    >
      <ServiceForm
        key={key}
        service={service}
        categories={categories}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

function ServiceForm({
  service,
  categories,
  onDone,
}: {
  service: Service | undefined;
  categories: string[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const priceFrom = centsFromText(formText(form, 'priceFrom'));
    const priceTo = centsFromText(formText(form, 'priceTo'));
    if (priceFrom === 'invalid' || priceTo === 'invalid') {
      setError('Enter prices as amounts, e.g. 65 or 65.50.');
      return;
    }
    const category = formText(form, 'category').trim();
    const body = {
      name: formText(form, 'name'),
      category: category === '' ? null : category,
      durationMinutes: Number(formText(form, 'duration')),
      bufferBeforeMinutes: Number(formText(form, 'bufferBefore') || '0'),
      bufferAfterMinutes: Number(formText(form, 'bufferAfter') || '0'),
      priceFromCents: priceFrom,
      priceToCents: priceTo,
      active: (form.elements.namedItem('active') as HTMLInputElement | null)?.checked ?? true,
    };
    setBusy(true);
    const answer =
      service === undefined
        ? await sendJson('POST', '/v1/services', body)
        : await sendJson('PUT', `/v1/services/${service.id}`, body);
    setBusy(false);
    if (answer.ok && ServiceSchema.safeParse(answer.data).success) {
      onDone();
      router.refresh();
      return;
    }
    setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
  }

  return (
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Field label="Name">
        <input name="name" required maxLength={120} defaultValue={service?.name ?? ''} />
      </Field>
      <Field label="Category" hint="Optional, e.g. Hair or Nails. Groups the menu.">
        <input
          name="category"
          list="service-categories"
          maxLength={60}
          defaultValue={service?.category ?? ''}
        />
      </Field>
      <datalist id="service-categories">
        {categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      <Field label="How long it takes (minutes)">
        <input
          name="duration"
          type="number"
          inputMode="numeric"
          min={5}
          max={720}
          step={5}
          required
          defaultValue={service?.durationMinutes ?? 60}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Price from ($)">
          <input
            name="priceFrom"
            inputMode="decimal"
            placeholder="None"
            defaultValue={textFromCents(service?.priceFromCents ?? null)}
          />
        </Field>
        <Field label="Up to ($)" hint="Optional, for a range.">
          <input
            name="priceTo"
            inputMode="decimal"
            placeholder="—"
            defaultValue={textFromCents(service?.priceToCents ?? null)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Prep before (min)">
          <input
            name="bufferBefore"
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            step={5}
            defaultValue={service?.bufferBeforeMinutes ?? 0}
          />
        </Field>
        <Field label="Clean-up after (min)">
          <input
            name="bufferAfter"
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            step={5}
            defaultValue={service?.bufferAfterMinutes ?? 0}
          />
        </Field>
      </div>
      <label className="flex min-h-11 items-center gap-3 font-semibold">
        <input
          name="active"
          type="checkbox"
          className="size-5 min-h-0 w-auto accent-brand"
          defaultChecked={service?.active ?? true}
        />
        Clients can book it
      </label>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className={buttonClass({ className: 'w-full' })}>
        {busy ? 'Saving…' : service === undefined ? 'Add service' : 'Save'}
      </button>
    </form>
  );
}
