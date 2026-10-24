'use client';

import { useId, useState } from 'react';
import { buttonClass, cx } from '../class-names.js';

export interface MailingAddressProps {
  /** The address rebooking emails carry, or `null` when none is set yet. */
  address: string | null;
  /** Saves it (`null` takes it away): `null` when it worked, else why not. */
  onSave: (address: string | null) => Promise<string | null>;
}

/**
 * The business's mailing address for rebooking emails (S36, ADR-0040): US law (CAN-SPAM) has
 * commercial email carry a postal address, so no nudge is drafted until an owner or manager
 * sets it. Shown to them only.
 */
export function MailingAddress({ address, onSave }: MailingAddressProps) {
  const fieldId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(address ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (address !== null && !editing) {
    return (
      <p className="m-0 text-sm text-ink-2" data-testid="mailing-address">
        Rebooking emails carry your address: {address.replaceAll('\n', ', ')}.{' '}
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-brand underline"
          onClick={() => {
            setValue(address);
            setEditing(true);
          }}
        >
          Change it
        </button>
      </p>
    );
  }
  return (
    <form
      aria-label="Mailing address for rebooking emails"
      className="flex flex-col gap-2 rounded-md border border-dashed border-accent p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void onSave(value).then((failed) => {
          setBusy(false);
          if (failed === null) setEditing(false);
          else setError(failed);
        });
      }}
    >
      <label htmlFor={fieldId} className="font-semibold">
        Your business’s mailing address
      </label>
      <p className="m-0 text-ink-2">
        I can draft rebooking emails for regulars who are due. By law they must show your postal
        address, so I need it first.
      </p>
      <textarea
        id={fieldId}
        className={cx(
          'min-h-20 w-full rounded-md border border-line bg-surface p-2 text-sm text-ink',
          'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
        )}
        value={value}
        maxLength={300}
        placeholder={'12 Main St\nPortland, OR 97201'}
        onChange={(event) => {
          setValue(event.target.value);
        }}
      />
      {error === null ? null : (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || value.trim() === ''}
          className={buttonClass({ size: 'sm' })}
        >
          Save address
        </button>
        {address === null ? null : (
          <button
            type="button"
            disabled={busy}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
            onClick={() => {
              setEditing(false);
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
