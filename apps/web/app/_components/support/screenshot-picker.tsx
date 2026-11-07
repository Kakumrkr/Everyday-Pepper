'use client';

import { Button, cx, IconButton } from '@pepper/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  ACCEPTED_SCREENSHOT_TYPES,
  discardScreenshot,
  imageFiles,
  MAX_SCREENSHOTS,
  precheckScreenshot,
  uploadScreenshot,
} from '../../../lib/support-screenshots';

// Screenshots on a request or reply (S59.2.3, AC-X-27): up to three, chosen, pasted or dropped;
// each uploads at once and shows as a thumbnail with its state and a remove button. Only the
// ready ones go with the message.

interface Draft {
  key: string;
  /** The local file's preview (an object URL), until it is removed or sent. */
  preview: string;
  name: string;
  state: 'adding' | 'ready' | 'failed';
  id?: string;
  error?: string;
}

/** The draft's screenshots: add files, remove one, the ids to send, and a reset after sending. */
export function useScreenshotDraft() {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const counter = useRef(0);
  const live = useRef<Draft[]>([]);
  live.current = drafts;

  // Previews are freed when the form goes away.
  useEffect(
    () => () => {
      for (const draft of live.current) URL.revokeObjectURL(draft.preview);
    },
    [],
  );

  const add = useCallback((files: readonly File[]) => {
    setNote(null);
    const room = MAX_SCREENSHOTS - live.current.filter((d) => d.state !== 'failed').length;
    if (files.length > room) {
      setNote(
        room <= 0
          ? 'That’s 3 screenshots, the most a message takes. Remove one to add another.'
          : `Only ${String(room)} more fit: a message takes 3 screenshots at most.`,
      );
    }
    for (const file of files.slice(0, Math.max(0, room))) {
      counter.current += 1;
      const key = `shot-${String(counter.current)}`;
      const problem = precheckScreenshot(file);
      const draft: Draft = {
        key,
        preview: URL.createObjectURL(file),
        name: file.name === '' ? 'Pasted screenshot' : file.name,
        state: problem === null ? 'adding' : 'failed',
        ...(problem !== null && { error: problem }),
      };
      setDrafts((current) => [...current, draft]);
      if (problem !== null) continue;
      void uploadScreenshot(file).then((answer) => {
        setDrafts((current) =>
          current.map((d) =>
            d.key !== key
              ? d
              : answer.ok
                ? { ...d, state: 'ready', id: answer.data.id }
                : { ...d, state: 'failed', error: answer.message },
          ),
        );
      });
    }
  }, []);

  const remove = useCallback((key: string) => {
    setNote(null);
    const draft = live.current.find((d) => d.key === key);
    if (draft === undefined) return;
    URL.revokeObjectURL(draft.preview);
    if (draft.id !== undefined) void discardScreenshot(draft.id);
    setDrafts((current) => current.filter((d) => d.key !== key));
  }, []);

  /** After sending: the previews go, the ids are the message's now. */
  const reset = useCallback(() => {
    for (const draft of live.current) URL.revokeObjectURL(draft.preview);
    setDrafts([]);
    setNote(null);
  }, []);

  /** Pasting an image anywhere in the form adds it (the text stays the textarea's). */
  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      const images = imageFiles(event.clipboardData.files);
      if (images.length === 0) return;
      event.preventDefault();
      add(images);
    },
    [add],
  );

  return {
    drafts,
    note,
    add,
    remove,
    reset,
    onPaste,
    ids: drafts.flatMap((d) => (d.state === 'ready' && d.id !== undefined ? [d.id] : [])),
    adding: drafts.some((d) => d.state === 'adding'),
  };
}

export type ScreenshotDraft = ReturnType<typeof useScreenshotDraft>;

/** The control: the add button (or a drop), the privacy line, the thumbnails. */
export function ScreenshotPicker({ draft }: { draft: ScreenshotDraft }) {
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const full = draft.drafts.filter((d) => d.state !== 'failed').length >= MAX_SCREENSHOTS;

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setOver(false);
    const images = imageFiles(event.dataTransfer.files);
    if (images.length > 0) draft.add(images);
  }

  return (
    <div
      className={cx(
        'flex flex-col gap-3 rounded-md border border-dashed px-4 py-3',
        over ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface',
      )}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => {
        setOver(false);
      }}
      onDrop={onDrop}
      data-testid="screenshot-picker"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={full}
          aria-describedby={`${ids}-hint`}
          onClick={() => input.current?.click()}
        >
          Add a screenshot
        </Button>
        <span id={`${ids}-hint`} className="type-caption text-ink-2">
          Up to 3.
          <span className="hidden sm:inline"> You can also paste or drop them here.</span>
        </span>
      </div>
      <p className="m-0 type-caption text-ink-2" data-testid="screenshot-privacy">
        Crop out client names and numbers before you send.
      </p>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_SCREENSHOT_TYPES}
        multiple
        hidden
        data-testid="screenshot-input"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length > 0) draft.add(files);
        }}
      />
      {draft.drafts.length === 0 ? null : (
        <ul className="m-0 flex list-none flex-wrap gap-3 p-0" aria-label="Screenshots to send">
          {draft.drafts.map((d, index) => (
            <li key={d.key} className="flex w-24 flex-col gap-1" data-testid="screenshot-draft">
              <div className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element -- a local preview (an object URL): nothing to optimise */}
                <img
                  src={d.preview}
                  alt={`Screenshot ${String(index + 1)}: ${d.name}`}
                  className={cx(
                    'block size-24 rounded-sm border border-line object-cover',
                    d.state === 'adding' && 'opacity-60',
                  )}
                />
                <IconButton
                  icon="close"
                  label={`Remove screenshot ${String(index + 1)}`}
                  variant="secondary"
                  className="absolute -top-2 -right-2 bg-surface"
                  onClick={() => {
                    draft.remove(d.key);
                  }}
                />
              </div>
              <span
                className={cx('type-caption', d.state === 'failed' ? 'text-danger' : 'text-ink-2')}
                aria-live="polite"
                data-testid="screenshot-state"
              >
                {d.state === 'adding' ? 'Adding…' : d.state === 'ready' ? 'Added' : 'Not added'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {draft.drafts.map((d, index) =>
        d.state === 'failed' ? (
          <p key={d.key} className="m-0 type-caption text-danger" role="alert">
            Screenshot {index + 1}: {d.error}
          </p>
        ) : null,
      )}
      {draft.note === null ? null : (
        <p className="m-0 type-caption text-ink" role="status">
          {draft.note}
        </p>
      )}
    </div>
  );
}
