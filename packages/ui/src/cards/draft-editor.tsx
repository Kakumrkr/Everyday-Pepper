'use client';

import { DRAFT_LIMITS, wordCount } from '@pepper/contracts';
import { useId, useState } from 'react';
import { buttonClass, cx } from '../class-names.js';

export interface DraftWords {
  subject: string;
  body: string;
}

export interface DraftEditorProps {
  draft: DraftWords;
  /** The viewer may decide the proposal now, so they may also change its words. */
  canEdit: boolean;
  /** Saves new words: `null` when it worked (the card then shows the new proposal), else why not. */
  onSave: (words: DraftWords) => Promise<string | null>;
}

const field = cx(
  'w-full rounded-md border border-line bg-surface p-2 text-sm text-ink',
  'focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-brand',
);

/**
 * A rebooking email's words on its "Needs your OK" card (S36, ADR-0040): shown as plain text,
 * exactly what will be sent above the booking time, link and footer the business adds. Whoever
 * may approve it may edit it first; saving replaces the proposal (a new fingerprint), so the
 * card then approves the edited words, never the old ones.
 */
export function DraftEditor({ draft, canEdit, onSave }: DraftEditorProps) {
  const subjectId = useId();
  const bodyId = useId();
  const countId = useId();
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = wordCount(body);

  if (!editing) {
    return (
      <section
        aria-label="The email"
        className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3 text-sm"
        data-testid="nudge-draft"
      >
        <p className="m-0">
          <span className="font-semibold">Subject:</span> {draft.subject}
        </p>
        <p className="m-0 whitespace-pre-wrap">{draft.body}</p>
        <p className="m-0 text-xs text-ink-2">
          Below it I add the open time, your booking link, your business name and address, and an
          unsubscribe link.
        </p>
        {canEdit ? (
          <div>
            <button
              type="button"
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
              onClick={() => {
                setSubject(draft.subject);
                setBody(draft.body);
                setError(null);
                setEditing(true);
              }}
            >
              Edit the words
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  return (
    <form
      aria-label="Edit the email"
      className="flex flex-col gap-2 rounded-md border border-line bg-bg p-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        void onSave({ subject, body }).then((failed) => {
          setBusy(false);
          if (failed === null) setEditing(false);
          else setError(failed);
        });
      }}
    >
      <label htmlFor={subjectId} className="font-semibold">
        Subject
      </label>
      <input
        id={subjectId}
        className={field}
        value={subject}
        maxLength={DRAFT_LIMITS.subjectMax}
        onChange={(event) => {
          setSubject(event.target.value);
        }}
      />
      <label htmlFor={bodyId} className="font-semibold">
        Message
      </label>
      <textarea
        id={bodyId}
        className={cx(field, 'min-h-32')}
        value={body}
        maxLength={DRAFT_LIMITS.bodyMax}
        aria-describedby={countId}
        onChange={(event) => {
          setBody(event.target.value);
        }}
      />
      <p
        id={countId}
        className={cx('m-0 text-xs', words > DRAFT_LIMITS.maxWords ? 'text-danger' : 'text-ink-2')}
      >
        {words} of {DRAFT_LIMITS.maxWords} words. No links, email addresses or phone numbers: I add
        the booking link.
      </p>
      {error === null ? null : (
        <p role="alert" className="m-0 text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || words > DRAFT_LIMITS.maxWords}
          className={buttonClass({ size: 'sm' })}
        >
          Save the words
        </button>
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
      </div>
    </form>
  );
}
