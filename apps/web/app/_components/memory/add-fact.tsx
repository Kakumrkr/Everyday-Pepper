'use client';

import { MEMORY_LIMITS, type MemorySubject } from '@pepper/contracts';
import { buttonStyle, cx, fieldStyle } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { toFactKey } from '../../../lib/memory';

/**
 * Adding a fact by hand (S32): what it is about ("Allergy", "Formula") and the note. Saved
 * from a screen, so it works while learning is paused (ADR-0034); health and personal keys are
 * sensitive unless said otherwise. A key the subject already has gets the new value.
 */
export function AddFact({
  subject,
  suggestions,
  legend,
  onAdded,
}: {
  subject: MemorySubject;
  suggestions: readonly string[];
  legend: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = toFactKey(label);
    if (key === null || value.trim() === '') {
      setError('Say what it is about and what to remember.');
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await sendJson('POST', '/v1/memory/facts', {
      subject,
      key,
      value: value.trim(),
      ...(sensitive && { sensitive: true }),
    });
    setBusy(false);
    if (!answer.ok) {
      setError(
        answer.status === 400
          ? 'Keep contact details on the client record, and the note under 500 characters.'
          : answer.message,
      );
      return;
    }
    setLabel('');
    setValue('');
    setSensitive(false);
    setOpen(false);
    onAdded();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className={cx(buttonStyle({ variant: 'secondary', size: 'sm' }), 'self-start')}
      >
        {legend}
      </button>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        void add(event);
      }}
      className="flex flex-col gap-2"
    >
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1 type-label">{legend}</legend>
        <label htmlFor={`${id}-key`} className="type-label">
          About
        </label>
        <input
          id={`${id}-key`}
          list={`${id}-keys`}
          value={label}
          maxLength={40}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
          className={cx(fieldStyle, 'min-h-11')}
        />
        <datalist id={`${id}-keys`}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
        <label htmlFor={`${id}-value`} className="type-label">
          Note
        </label>
        <input
          id={`${id}-value`}
          value={value}
          maxLength={MEMORY_LIMITS.valueMax}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          className={cx(fieldStyle, 'min-h-11')}
        />
        <label className="flex min-h-11 items-center gap-2 type-label">
          <input
            type="checkbox"
            checked={sensitive}
            onChange={(event) => {
              setSensitive(event.target.checked);
            }}
            className="size-5"
          />
          Sensitive (health or personal): only owners, managers and their stylist see it
        </label>
      </fieldset>
      {error === null ? null : (
        <p role="alert" className="m-0 type-label text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={buttonStyle({ size: 'sm' })}>
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          className={buttonStyle({ variant: 'secondary', size: 'sm' })}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
