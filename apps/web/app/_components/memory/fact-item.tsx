'use client';

import { MEMORY_LIMITS, MemoryFactSchema, type MemoryFactView } from '@pepper/contracts';
import { Badge, buttonStyle, cx, fieldStyle, Icon } from '@pepper/ui';
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
    <div className="flex flex-col gap-1.5 py-3">
      {mode === 'edit' ? (
        <form
          onSubmit={(event) => {
            void save(event);
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor={inputId} className="type-label">
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
            className={cx(fieldStyle, 'min-h-11')}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonStyle({ size: 'sm' })}>
              Save
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setDraft(fact.value);
                setMode('view');
              }}
              className={buttonStyle({ variant: 'secondary', size: 'sm' })}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p className="m-0 type-body whitespace-pre-wrap">
            <b>{label}:</b> {fact.value}
          </p>
          {about === null ? null : <p className="m-0 type-label text-ink-2">{about}</p>}
          <p className="m-0 type-caption text-ink-3">{sourceLine(fact, timeZone)}</p>
          {fact.sensitive || rule !== null ? (
            <div className="flex flex-wrap gap-2">
              {fact.sensitive ? (
                <Badge tone="warn">
                  <Icon name="lock" className="size-3.5" />
                  Sensitive
                </Badge>
              ) : null}
              {rule === null ? null : (
                <Link href={rule} className={buttonStyle({ variant: 'quiet', size: 'sm' })}>
                  See the rule
                </Link>
              )}
            </div>
          ) : null}
        </>
      )}
      {mode === 'confirm' ? (
        <div role="group" aria-label={`Delete ${label}?`} className="flex flex-col gap-2">
          <p className="m-0 type-body">
            Delete this? I’ll forget it everywhere, chats included. It can’t be undone.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void forget();
              }}
              className={buttonStyle({ variant: 'danger', size: 'sm' })}
            >
              Delete
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setMode('view');
              }}
              className={buttonStyle({ variant: 'secondary', size: 'sm' })}
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
            className={buttonStyle({ variant: 'quiet', size: 'sm' })}
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
            className={buttonStyle({ variant: 'quiet', size: 'sm' })}
          >
            Delete
          </button>
        </div>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="m-0 type-label text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
