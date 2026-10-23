'use client';

import { MEMORY_LIMITS, MemoryFactSchema, type MemoryFactView } from '@pepper/contracts';
import { buttonClass, cx, Icon } from '@pepper/ui';
import Link from 'next/link';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { aboutLine, factLabel, ruleLink, sourceLine } from '../../../lib/memory';

type Mode = 'view' | 'edit' | 'confirm';

/**
 * One remembered fact on "What I know" and the client profile (S32): what it is, whom it is
 * about, where it came from and when (playbook M-5), with Edit and Delete in place for members
 * who may change it. Delete is final after one confirm (playbook D-11): forgotten everywhere,
 * in chats too. Values are plain text.
 */
export function FactItem({
  fact,
  timeZone,
  canChange,
  about: aboutGiven,
  onChanged,
  onForgotten,
}: {
  fact: MemoryFactView;
  timeZone: string;
  canChange: boolean;
  /** Whom it is about, if not the usual line (on a client's own profile, just the visit). */
  about?: string | null;
  onChanged: (fact: MemoryFactView) => void;
  onForgotten: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('view');
  const [draft, setDraft] = useState(fact.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const label = factLabel(fact.key);
  const about = aboutGiven === undefined ? aboutLine(fact, timeZone) : aboutGiven;
  const rule = ruleLink(fact);

  async function save(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (value === '' || value === fact.value) {
      setMode('view');
      return;
    }
    setBusy(true);
    setError(null);
    const answer = await sendJson('PATCH', `/v1/memory/facts/${fact.id}`, { value });
    setBusy(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    setMode('view');
    const changed = MemoryFactSchema.safeParse(answer.data);
    onChanged(
      changed.success
        ? {
            ...fact,
            value: changed.data.value,
            sensitive: changed.data.sensitive,
            updatedAt: changed.data.updatedAt,
          }
        : { ...fact, value },
    );
  }

  async function forget() {
    setBusy(true);
    setError(null);
    const answer = await sendJson('DELETE', `/v1/memory/facts/${fact.id}`, undefined);
    setBusy(false);
    // Already gone is what was asked for.
    if (answer.ok || answer.status === 404) onForgotten(fact.id);
    else setError(answer.message);
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-3">
      {mode === 'edit' ? (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={inputId} className="text-sm font-semibold">
            {label}
            {about === null ? null : <span className="font-normal text-ink-2"> · {about}</span>}
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
                setDraft(fact.value);
                setMode('view');
              }}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="m-0 whitespace-pre-wrap">
            <b>{label}:</b> {fact.value}
          </p>
          {about === null ? null : <p className="m-0 text-sm text-ink-2">{about}</p>}
          <p className="m-0 text-xs text-ink-2">{sourceLine(fact, timeZone)}</p>
          {fact.sensitive || rule !== null ? (
            <div className="flex flex-wrap gap-2">
              {fact.sensitive ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-wait-soft px-2 text-xs font-semibold text-wait">
                  <Icon name="lock" className="size-3.5" />
                  Sensitive
                </span>
              ) : null}
              {rule === null ? null : (
                <Link href={rule} className="text-xs font-semibold text-brand underline">
                  See the rule
                </Link>
              )}
            </div>
          ) : null}
        </>
      )}
      {mode === 'confirm' ? (
        <div role="group" aria-label={`Delete ${label}?`} className="flex flex-col gap-2">
          <p className="m-0 text-sm">
            Delete this? I’ll forget it everywhere, chats included. It can’t be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void forget();
              }}
              className={buttonClass({ size: 'sm', className: 'bg-danger hover:bg-danger' })}
            >
              Delete
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
      ) : null}
      {mode === 'view' && canChange ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-label={`Edit ${label}${about === null ? '' : ` (${about})`}`}
            onClick={() => {
              setError(null);
              setMode('edit');
            }}
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
          >
            Edit
          </button>
          <button
            type="button"
            aria-label={`Delete ${label}${about === null ? '' : ` (${about})`}`}
            onClick={() => {
              setError(null);
              setMode('confirm');
            }}
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
          >
            Delete
          </button>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className={cx('m-0 text-sm text-danger')}>
          {error}
        </p>
      )}
    </div>
  );
}
