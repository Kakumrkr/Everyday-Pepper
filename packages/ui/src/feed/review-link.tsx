'use client';

import { useId, useState } from 'react';
import { cx } from '../class-names.js';
import { buttonStyle } from '../kit/button.js';
import { fieldStyle } from '../kit/fields.js';

export interface ReviewLinkProps {
  /** Where review requests send clients, or `null` when none is set yet. */
  url: string | null;
  /** Whether the mailing address is set: without it no request can go (CAN-SPAM). */
  addressSet: boolean;
  /** Saves it (`null` takes it away): `null` when it worked, else why not. */
  onSave: (url: string | null) => Promise<string | null>;
}

/**
 * The business's review link for post-visit review requests (S55.2, ADR-0059): until an owner
 * or manager sets it, no request is drafted. Shown to them only.
 */
export function ReviewLink({ url, addressSet, onSave }: ReviewLinkProps) {
  const fieldId = useId();
  const hintId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(url ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = (next: string | null) => {
    setBusy(true);
    setError(null);
    void onSave(next).then((failed) => {
      setBusy(false);
      if (failed !== null) {
        setError(failed);
        return;
      }
      setEditing(false);
      // Taken away: the empty form is what shows next.
      if (next === null) setValue('');
    });
  };

  if (url !== null && !editing) {
    return (
      <div className="flex flex-col gap-1" data-testid="review-link">
        <p className="m-0 type-body break-all text-ink-2">
          The morning after a visit, I draft a thank-you that asks for a review at {url}.
        </p>
        <button
          type="button"
          className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4 self-start')}
          onClick={() => {
            setValue(url);
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
      aria-label="Review link for review requests"
      noValidate
      className="flex flex-col gap-3 type-body text-ink"
      onSubmit={(event) => {
        event.preventDefault();
        save(value);
      }}
    >
      <label htmlFor={fieldId} className="type-subheading">
        Your review link
      </label>
      <p id={hintId} className="m-0 text-ink-2">
        The morning after a visit, I can draft a short thank-you that asks the client for a review.
        You approve each one, and no client is asked more than once in 90 days. Paste the link to
        your Google, Yelp or own review page.
        {addressSet ? null : ' They carry your mailing address too, so add it above first.'}
      </p>
      <input
        id={fieldId}
        type="url"
        inputMode="url"
        autoComplete="url"
        aria-describedby={hintId}
        className={fieldStyle}
        value={value}
        maxLength={500}
        placeholder="https://g.page/r/your-business/review"
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
          Save link
        </button>
        {url === null ? null : (
          <>
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
            <button
              type="button"
              disabled={busy}
              className={buttonStyle({ variant: 'quiet', size: 'sm' })}
              onClick={() => {
                save(null);
              }}
            >
              Stop asking for reviews
            </button>
          </>
        )}
      </div>
    </form>
  );
}
