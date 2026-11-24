'use client';

import { ServiceSchema, type Service } from '@pepper/contracts';
import {
  Button,
  buttonStyle,
  Checkbox,
  Icon,
  Input,
  Segmented,
  Sheet,
  SheetFooter,
} from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import {
  DEPOSIT_CHOICES,
  depositFields,
  depositRuleFrom,
  percentPreview,
  type DepositFields,
} from '../../../lib/deposits';
import { centsFromText, textFromCents } from '../../../lib/setup';
import { Notice } from '../form-parts';

/**
 * Adds a service to the menu (`POST /v1/services`) or edits one (`PUT /v1/services/:id`, all
 * fields). Owners and managers only; the api checks it again. On the kit (S42.2): its fields,
 * and Save in the sheet's footer within thumb reach (D3). Since S66.2 its deposit (AC-X-121).
 */
export function ServiceEditor({
  service,
  categories,
  open: shown,
  onOpenChange,
  deposits = 'hidden',
}: {
  /** The service to edit; none adds a new one. */
  service?: Service;
  /**
   * Whether the deposit field shows (S66.2): `open` when the business can take card payments,
   * `waiting` while Stripe isn't ready (the field shows and says so), `hidden` with payments off
   * in this deployment (the rule is left as it is).
   */
  deposits?: DepositsState;
  /** Categories in use, offered as suggestions. */
  categories: string[];
  /** Opened from elsewhere too (the empty menu's "Add your first service"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
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
        deposits={deposits}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

export type DepositsState = 'open' | 'waiting' | 'hidden';

function ServiceForm({
  service,
  categories,
  deposits,
  onDone,
}: {
  service: Service | undefined;
  categories: string[];
  deposits: DepositsState;
  onDone: () => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [priceText, setPriceText] = useState(textFromCents(service?.priceFromCents ?? null));
  const [deposit, setDeposit] = useState<DepositFields>(() => depositFields(service?.deposit));
  const [depositError, setDepositError] = useState<string | null>(null);
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
    const checked = deposits === 'hidden' ? null : depositRuleFrom(deposit, priceFrom);
    if (checked !== null && !checked.ok) {
      setDepositError(checked.message);
      setError(null);
      return;
    }
    setDepositError(null);
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
      // Left out while payments are off here: the api keeps the stored rule.
      ...(checked === null ? {} : { deposit: checked.rule }),
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
          value={priceText}
          onChange={(event) => {
            setPriceText(event.target.value);
          }}
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
      {deposits === 'hidden' ? null : (
        <DepositField
          fields={deposit}
          onChange={(next) => {
            setDeposit(next);
            setDepositError(null);
          }}
          priceFromCents={(() => {
            const cents = centsFromText(priceText);
            return cents === 'invalid' ? null : cents;
          })()}
          waiting={deposits === 'waiting'}
          error={depositError}
        />
      )}
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

/**
 * What booking the service online asks for (AC-X-121): nothing, an amount, a percent of the
 * price (with what it comes to), or a card on file. The refund window is the business's, in
 * booking page settings.
 */
function DepositField({
  fields,
  onChange,
  priceFromCents,
  waiting,
  error,
}: {
  fields: DepositFields;
  onChange: (fields: DepositFields) => void;
  priceFromCents: number | null;
  waiting: boolean;
  error: string | null;
}) {
  const headingId = useId();
  const preview = fields.kind === 'percent' ? percentPreview(fields.percent, priceFromCents) : null;
  return (
    <fieldset aria-labelledby={headingId} className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend id={headingId} className="p-0 type-label text-ink">
        Deposit when booked online
      </legend>
      <Segmented
        label="Deposit"
        options={DEPOSIT_CHOICES}
        value={fields.kind}
        onValueChange={(kind) => {
          const next = DEPOSIT_CHOICES.find((choice) => choice.value === kind)?.value;
          if (next !== undefined) onChange({ ...fields, kind: next });
        }}
      />
      {fields.kind === 'fixed' ? (
        <Input
          label="Deposit ($)"
          name="depositAmount"
          inputMode="decimal"
          placeholder="15"
          value={fields.amount}
          error={error ?? undefined}
          hint="Paid when booking. The rest is paid at the visit."
          onChange={(event) => {
            onChange({ ...fields, amount: event.target.value });
          }}
        />
      ) : null}
      {fields.kind === 'percent' ? (
        <Input
          label="Deposit (% of the price)"
          name="depositPercent"
          inputMode="numeric"
          placeholder="20"
          value={fields.percent}
          error={error ?? undefined}
          hint={preview ?? 'A percent of the “Price from” above.'}
          onChange={(event) => {
            onChange({ ...fields, percent: event.target.value });
          }}
        />
      ) : null}
      {fields.kind === 'card' ? (
        <p className="m-0 type-caption text-ink-2">
          Clients add a card to book. Nothing is charged now.
        </p>
      ) : null}
      {fields.kind === 'none' ? (
        <p className="m-0 type-caption text-ink-2">Clients book without paying anything.</p>
      ) : null}
      {error !== null && (fields.kind === 'none' || fields.kind === 'card') ? (
        <Notice tone="error">{error}</Notice>
      ) : null}
      {waiting && fields.kind !== 'none' ? (
        <p className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          Deposits start once Stripe payments are ready (More → Payments). Until then, clients can’t
          book this service online.
        </p>
      ) : null}
    </fieldset>
  );
}
