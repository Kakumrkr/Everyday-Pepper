'use client';

import {
  SUPPORT_MESSAGE_MAX,
  SupportCreatedSchema,
  type SupportContextInput,
  type SupportCreated,
  type SupportKind,
} from '@pepper/contracts';
import { Button, buttonStyle, cx, FOCUS_RING, Textarea } from '@pepper/ui';
import Link from 'next/link';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { SUPPORT_KINDS, SUPPORT_PATHS, supportContext } from '../../../lib/support';
import { Notice } from '../form-parts';

/**
 * "Tell us what went wrong" (S59, PCR-010, AC-X-14): what it is about, the message, and what is
 * added to it, said before it is sent. A request from an error state comes in as a problem with
 * the error's reference. Answers come to the requester's email and to "Your requests".
 */
export function SupportForm({
  query,
  email,
  seesAll,
}: {
  /** The address's `from`, `topic` and `error`: where the request comes from. */
  query: { from: string | null; topic: string | null; error: string | null };
  /** Where the answer goes: the signed-in member's email. */
  email: string;
  /** Owners and managers read every request; staff are told the owners can read theirs. */
  seesAll: boolean;
}) {
  const ids = useId();
  const [kind, setKind] = useState<SupportKind>(
    query.error !== null ? 'problem' : query.topic !== null ? 'question' : 'problem',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [created, setCreated] = useState<SupportCreated | null>(null);

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = formText(form, 'message');
    if (message === '') {
      setFieldError('Write a few words about it.');
      form.querySelector<HTMLElement>('[name="message"]')?.focus();
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    const context: SupportContextInput = supportContext(query, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    const result = await sendJson('POST', '/v1/support/threads', { kind, message, context });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const parsed = SupportCreatedSchema.safeParse(result.data);
    if (!parsed.success) {
      setError('I sent it, but couldn’t read the answer. Check Your requests.');
      return;
    }
    setCreated(parsed.data);
  }

  if (created !== null) {
    return (
      <section
        aria-labelledby={`${ids}-sent`}
        className="flex flex-col gap-4 rounded-lg bg-ok-soft px-5 py-6"
        data-testid="support-sent"
      >
        <h2 id={`${ids}-sent`} className="m-0 type-heading text-ink">
          We got it
        </h2>
        <p className="m-0 type-body text-ink">
          Your reference is{' '}
          <span className="font-semibold tabular-nums" data-testid="support-reference">
            {created.reference}
          </span>
          . We answer the same day, at{' '}
          <span className="font-semibold break-all">{created.replyTo}</span> and here in Your
          requests.
        </p>
        <div className="flex flex-wrap gap-3">
          {created.id === null ? null : (
            <Link
              href={SUPPORT_PATHS.thread(created.id)}
              className={buttonStyle({ variant: 'primary' })}
            >
              See your request
            </Link>
          )}
          <Link href={SUPPORT_PATHS.list} className={buttonStyle({ variant: 'secondary' })}>
            Your requests
          </Link>
        </div>
      </section>
    );
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-6">
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 type-subheading text-ink">What is it about?</legend>
        {SUPPORT_KINDS.map((option) => {
          const selected = option.value === kind;
          return (
            <label
              key={option.value}
              className={cx(
                'flex min-h-14 cursor-pointer items-center gap-3 rounded-md border px-4 py-3',
                selected ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface',
              )}
            >
              <input
                type="radio"
                name="kind"
                value={option.value}
                checked={selected}
                onChange={() => {
                  setKind(option.value);
                }}
                className={cx(
                  'size-5 min-h-0 shrink-0 cursor-pointer p-0 accent-brand',
                  FOCUS_RING,
                )}
              />
              <span className="flex min-w-0 flex-col">
                <span className="type-body font-semibold text-ink">{option.label}</span>
                <span className="type-caption text-ink-2">{option.hint}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      <Textarea
        label="Tell us what happened"
        name="message"
        rows={6}
        maxLength={SUPPORT_MESSAGE_MAX}
        required
        hint={
          kind === 'problem'
            ? 'What you tapped, what you expected and what you saw instead.'
            : 'As much or as little as you like.'
        }
        error={fieldError}
      />
      <div className="flex flex-col gap-1 rounded-md bg-surface-2 px-4 py-3">
        <p className="m-0 type-label text-ink">We add, so you don’t have to type it</p>
        <p className="m-0 type-caption text-ink-2">
          The page you came from, the app version, your browser and how far your setup is. Never
          your clients’ details.
        </p>
        <p className="m-0 type-caption text-ink-2">
          {seesAll
            ? 'You and the other owners and managers can read this request.'
            : 'You and your business’s owners and managers can read this request.'}{' '}
          We reply to <span className="font-semibold break-all">{email}</span>.
        </p>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send to Pepper'}
        </Button>
        <Link
          href={SUPPORT_PATHS.list}
          className={cx(
            'inline-flex min-h-11 items-center type-label text-ink-2 underline underline-offset-4',
            FOCUS_RING,
          )}
        >
          Your requests
        </Link>
      </div>
    </form>
  );
}
