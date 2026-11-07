'use client';

import { SUPPORT_MESSAGE_MAX, type SupportNote } from '@pepper/contracts';
import { Button, Textarea } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { formText } from '../../../lib/form';
import { supportTime } from '../../../lib/support';

/**
 * The team's notes on a request (S59.2, AC-X-21): only operators ever see them, so they are
 * styled apart from the conversation (a dashed, warm block) and say so.
 */
export function OpsNotes({
  notes,
  now,
  busy,
  onAdd,
}: {
  notes: readonly SupportNote[];
  now: number;
  busy: boolean;
  /** Saves the note; resolves to whether it was saved. */
  onAdd: (note: string) => Promise<boolean>;
}) {
  const ids = useId();
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);

  async function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const note = formText(form, 'note');
    if (note === '') {
      setFieldError('Write the note first.');
      form.querySelector<HTMLElement>('[name="note"]')?.focus();
      return;
    }
    setFieldError(undefined);
    if (await onAdd(note)) form.reset();
  }

  return (
    <section
      aria-labelledby={`${ids}-notes`}
      className="flex flex-col gap-3 rounded-lg border border-dashed border-line bg-warn-soft px-4 py-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={`${ids}-notes`} className="m-0 type-title">
          Team notes
        </h2>
        <p className="m-0 type-caption text-ink-2">Only the Pepper team sees these.</p>
      </div>
      {notes.length === 0 ? null : (
        <ol aria-label="Notes" className="m-0 flex list-none flex-col gap-2 p-0">
          {notes.map((note) => (
            <li key={note.id} className="flex flex-col gap-1">
              <span className="type-caption text-ink-2">
                <span className="font-semibold text-ink">{note.author ?? 'A former teammate'}</span>{' '}
                ·{' '}
                <span className="tabular-nums">{supportTime(note.createdAt, 'UTC', now)} UTC</span>
              </span>
              <p className="m-0 type-body break-words whitespace-pre-wrap text-ink">{note.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form noValidate onSubmit={(event) => void add(event)} className="flex flex-col gap-3">
        <Textarea
          label="Add a note"
          name="note"
          rows={2}
          maxLength={SUPPORT_MESSAGE_MAX}
          error={fieldError}
        />
        <div>
          <Button type="submit" variant="secondary" disabled={busy}>
            {busy ? 'Saving…' : 'Save note'}
          </Button>
        </div>
      </form>
    </section>
  );
}
