'use client';

import { ServiceSchema, type Service } from '@pepper/contracts';
import { Button, buttonStyle, Checkbox, Icon, Input, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { centsFromText, textFromCents } from '../../../lib/setup';
import { Notice } from '../form-parts';

/**
 * Adds a service to the menu (`POST /v1/services`) or edits one (`PUT /v1/services/:id`, all
 * fields). Owners and managers only; the api checks it again. On the kit (S42.2): its fields,
 * and Save in the sheet's footer within thumb reach (D3).
 */
export function ServiceEditor({
  service,
  categories,
  open: shown,
  onOpenChange,
  returnFocus,
}: {
  /** The service to edit; none adds a new one. */
  service?: Service;
  /** Categories in use, offered as suggestions. */
  categories: string[];
  /** Opened from elsewhere too (the empty menu's "Add your first service"). */
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
      title={service === undefined ? 'Add a service' : `Edit ${service.name}`}
      open={open}
      returnFocus={returnFocus}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        service === undefined ? (
          <button type="button" className={buttonStyle({ size: 'sm' })}>
            <Icon name="plus" />
            Add service
          </button>
        ) : (
          <button
            type="button"
            className={buttonStyle({ variant: 'quiet', size: 'sm' })}
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
  const formId = useId();

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
    <form id={formId} className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Input label="Name" name="name" required maxLength={120} defaultValue={service?.name ?? ''} />
      <Input
        label="Category"
        hint="Optional, e.g. Hair or Nails. Groups the menu."
        name="category"
        list="service-categories"
        maxLength={60}
        defaultValue={service?.category ?? ''}
      />
      <datalist id="service-categories">
        {categories.map((category) => (
          <option key={category} value={category} />
        ))}
      </datalist>
      <Input
        label="How long it takes (minutes)"
        name="duration"
        type="number"
        inputMode="numeric"
        min={5}
        max={720}
        step={5}
        required
        defaultValue={service?.durationMinutes ?? 60}
      />
      <div className="grid grid-cols-2 items-end gap-3">
        <Input
          label="Price from ($)"
          name="priceFrom"
          inputMode="decimal"
          placeholder="None"
          defaultValue={textFromCents(service?.priceFromCents ?? null)}
        />
        <Input
          label="Up to ($)"
          hint="Optional, for a range."
          name="priceTo"
          inputMode="decimal"
          placeholder="—"
          defaultValue={textFromCents(service?.priceToCents ?? null)}
        />
      </div>
      <div className="grid grid-cols-2 items-end gap-3">
        <Input
          label="Prep before (min)"
          name="bufferBefore"
          type="number"
          inputMode="numeric"
          min={0}
          max={240}
          step={5}
          defaultValue={service?.bufferBeforeMinutes ?? 0}
        />
        <Input
          label="Clean-up after (min)"
          name="bufferAfter"
          type="number"
          inputMode="numeric"
          min={0}
          max={240}
          step={5}
          defaultValue={service?.bufferAfterMinutes ?? 0}
        />
      </div>
      <Checkbox
        name="active"
        label="Clients can book it"
        defaultChecked={service?.active ?? true}
      />
      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Button type="submit" form={formId} busy={busy} block size="lg">
          {busy ? 'Saving…' : service === undefined ? 'Add service' : 'Save'}
        </Button>
      </SheetFooter>
    </form>
  );
}
