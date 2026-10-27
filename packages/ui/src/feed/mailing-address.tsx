'use client';

import { useId, useState } from 'react';
import { cx } from '../class-names.js';
import { buttonStyle } from '../kit/button.js';
import { fieldStyle } from '../kit/fields.js';

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
      <div className="flex flex-wrap items-center gap-x-2" data-testid="mailing-address">
        <p className="m-0 type-body text-ink-2">
          Rebooking emails carry your address: {address.replaceAll('\n', ', ')}.
        </p>
        <button
          type="button"
          className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4')}
          onClick={() => {
            setValue(address);
            setEditing(true);
          }}
        >
          Change it
        </button>
      </div>
    );
  }
  return (
    <form
      aria-label="Mailing address for rebooking emails"
      className="flex flex-col gap-3 rounded-lg bg-surface p-5 type-body text-ink shadow-raised"
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
      <label htmlFor={fieldId} className="type-subheading">
        Your business’s mailing address
      </label>
      <p className="m-0 text-ink-2">
        I can draft rebooking emails for regulars who are due. By law they must show your postal
        address, so I need it first.
      </p>
      <textarea
        id={fieldId}
        className={cx(fieldStyle, 'min-h-24 py-3')}
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
          className={buttonStyle({ size: 'sm' })}
        >
          Save address
        </button>
        {address === null ? null : (
          <button
            type="button"
            disabled={busy}
            className={buttonStyle({ variant: 'secondary', size: 'sm' })}
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
