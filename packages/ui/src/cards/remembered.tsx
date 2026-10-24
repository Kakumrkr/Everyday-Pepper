'use client';

import { MEMORY_LIMITS, type MemoryFactShown } from '@pepper/contracts';
import { useId, useState, type SubmitEvent } from 'react';
import { buttonClass, chipClass, cx } from '../class-names.js';
import { Icon } from '../icons.js';
import { keyWords } from './labels.js';

/** What a fix or a forget came to: `null` when it worked, else a message to show. */
export type MemoryChange = Promise<string | null>;

export interface RememberedProps {
  /** How many facts the answer used. */
  count: number;
  /** The facts read live; `null` while they load. */
  facts: readonly MemoryFactShown[] | null;
  /** Why they could not be read, if they could not. */
  error?: string | null;
  open: boolean;
  onToggle: () => void;
  onFix: (factId: string, value: string) => MemoryChange;
  onForget: (factId: string) => MemoryChange;
}

/**
 * The "Remembered" chip under an answer that used memory (S32, playbook D-16, M-4): it opens
 * the facts the answer used, read live, each with Fix and Forget in place. Forget is final
 * after one confirm (playbook D-11): Pepper won't use it again in any chat. Values are plain
 * text; a fact deleted since (or not the member's to read) shows as no longer remembered.
 */
export function Remembered({
  count,
  facts,
  error = null,
  open,
  onToggle,
  onFix,
  onForget,
}: RememberedProps) {
  const panelId = useId();
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className={chipClass({ selected: open, className: 'self-start' })}
      >
        <Icon name="memory" className="text-brand" />
        Remembered{count > 1 ? ` · ${String(count)}` : ''}
      </button>
      {open ? (
        <section
          id={panelId}
          aria-label="What I remembered for this answer"
          className="flex max-w-[62ch] flex-col gap-2 rounded-md border border-line bg-surface p-3"
        >
          {error !== null ? (
            <p role="alert" className="m-0 text-sm text-danger">
              {error}
            </p>
          ) : facts === null ? (
            <p className="m-0 text-sm text-ink-2">Reading what I remembered…</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {facts.map((fact) => (
                <li key={fact.factId}>
                  <FactRow fact={fact} onFix={onFix} onForget={onForget} />
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

type Mode = 'view' | 'fix' | 'confirm';

function FactRow({
  fact,
  onFix,
  onForget,
}: {
  fact: MemoryFactShown;
  onFix: RememberedProps['onFix'];
  onForget: RememberedProps['onForget'];
}) {
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState(fact.state === 'known' ? fact.value : '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [forgotten, setForgotten] = useState(false);
  // The value as last saved here (the facts read on opening are not read again until reopened).
  const [saved, setSaved] = useState<string | null>(null);
  const inputId = useId();

  if (fact.state === 'gone' || forgotten) {
    return (
      <p role={forgotten ? 'status' : undefined} className="m-0 text-sm text-ink-2">
        {forgotten ? 'Forgotten. I won’t use it again.' : 'No longer remembered.'}
      </p>
    );
  }
  const label = keyWords(fact.key) ?? 'Fact';
  const { factId } = fact;
  const current = saved ?? fact.value;

  async function run(work: () => MemoryChange, done: () => void) {
    setBusy(true);
    setMessage(null);
    const failure = await work();
    setBusy(false);
    if (failure === null) done();
    else setMessage(failure);
  }

  function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (value === '' || value === current) {
      setMode('view');
      return;
    }
    void run(
      () => onFix(factId, value),
      () => {
        setSaved(value);
        setMode('view');
        setMessage('Saved.');
      },
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="m-0 whitespace-pre-wrap">
        <b>{label}:</b> {current}
        {fact.sensitive ? (
          <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 text-xs font-semibold text-ink-2">
            <Icon name="lock" className="size-3.5" />
            Sensitive
          </span>
        ) : null}
      </p>
      {mode === 'fix' ? (
        <form onSubmit={save} className="flex flex-col gap-2">
          <label htmlFor={inputId} className="text-sm font-semibold">
            {label}
          </label>
          <input
            id={inputId}
            value={draft}
            maxLength={MEMORY_LIMITS.valueMax}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            className="min-h-11 rounded-md border border-line bg-surface px-3"
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonClass({ size: 'sm' })}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(current);
                setMode('view');
              }}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : mode === 'confirm' ? (
        <div role="group" aria-label={`Forget ${label}?`} className="flex flex-col gap-2">
          <p className="m-0 text-sm">
            Forget this everywhere? I won’t use it again in any chat, and it can’t be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(
                  () => onForget(factId),
                  () => {
                    setForgotten(true);
                  },
                );
              }}
              className={buttonClass({ size: 'sm', className: 'bg-danger hover:bg-danger' })}
            >
              Forget
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('view');
              }}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-label={`Fix ${label}`}
            onClick={() => {
              setMessage(null);
              setMode('fix');
            }}
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
          >
            Fix
          </button>
          <button
            type="button"
            aria-label={`Forget ${label}`}
            onClick={() => {
              setMessage(null);
              setMode('confirm');
            }}
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
          >
            Forget
          </button>
        </div>
      )}
      {message === null ? null : (
        <p role="status" className={cx('m-0 text-sm', message !== 'Saved.' && 'text-danger')}>
          {message}
        </p>
      )}
    </div>
  );
}
