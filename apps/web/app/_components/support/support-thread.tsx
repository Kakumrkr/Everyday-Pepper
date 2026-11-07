'use client';

import { SUPPORT_MESSAGE_MAX, SupportThreadSchema, type SupportThread } from '@pepper/contracts';
import { Badge, Button, cx, Textarea } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { SUPPORT_KIND_LABEL, SUPPORT_STATUS, authorLabel, supportTime } from '../../../lib/support';
import { Notice } from '../form-parts';

/**
 * A support request as a thread (S59, PCR-010, AC-X-15/16): the team's answers on the left in
 * `surface`, the business's messages on the right in `brand-soft`, each with who and when. A
 * reply reopens a solved request; "Mark as solved" is a quiet action beside the reply.
 */
export function SupportThreadView({
  initial,
  timeZone,
}: {
  initial: SupportThread;
  timeZone: string;
}) {
  const ids = useId();
  const router = useRouter();
  const [thread, setThread] = useState(initial);
  const [busy, setBusy] = useState<'reply' | 'solve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [now] = useState(() => Date.now());
  const status = SUPPORT_STATUS[thread.status];
  // The shell's unread count may have been read before this page marked the answers read (a
  // layout and its page load side by side): read it again once, now that they are.
  useEffect(() => {
    router.refresh();
  }, [router]);

  function take(data: unknown): boolean {
    const parsed = SupportThreadSchema.safeParse(data);
    if (!parsed.success) {
      setError('Done, but I couldn’t show it. Reload the page.');
      return false;
    }
    setThread(parsed.data);
    // More's unread count and the list read the new state on the next visit.
    router.refresh();
    return true;
  }

  async function reply(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = formText(form, 'message');
    if (message === '') {
      setFieldError('Write your reply first.');
      form.querySelector<HTMLElement>('[name="message"]')?.focus();
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy('reply');
    const result = await sendJson('POST', `/v1/support/threads/${thread.id}/messages`, { message });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (take(result.data)) form.reset();
  }

  async function solve() {
    setError(null);
    setBusy('solve');
    const result = await sendJson('PATCH', `/v1/support/threads/${thread.id}`, {
      status: 'solved',
    });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    take(result.data);
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-title">{SUPPORT_KIND_LABEL[thread.kind]}</h1>
        <p className="m-0 flex flex-wrap items-center gap-2 type-caption text-ink-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="tabular-nums" data-testid="support-thread-reference">
            {thread.reference}
          </span>
          {thread.openedBy.kind === 'you' ? null : (
            <span>· from {authorLabel(thread.openedBy)}</span>
          )}
        </p>
      </header>
      <ol aria-label="Messages" className="m-0 flex list-none flex-col gap-3 p-0">
        {thread.messages.map((message) => {
          const pepper = message.author.kind === 'pepper';
          return (
            <li
              key={message.id}
              className={cx('flex flex-col gap-1', pepper ? 'items-start' : 'items-end')}
            >
              <span className="type-caption text-ink-2">
                <span className="font-semibold text-ink">{authorLabel(message.author)}</span> ·{' '}
                <span className="tabular-nums">
                  {supportTime(message.createdAt, timeZone, now)}
                </span>
              </span>
              <p
                className={cx(
                  'm-0 max-w-11/12 rounded-lg px-4 py-3 type-body break-words whitespace-pre-wrap text-ink',
                  pepper ? 'border border-line bg-surface' : 'bg-brand-soft',
                )}
              >
                {message.body}
              </p>
            </li>
          );
        })}
      </ol>
      {thread.status === 'pepper_replied' ? (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">
          Did that answer it? Reply if not, or mark it solved.
        </p>
      ) : thread.status === 'solved' ? (
        <p className="m-0 rounded-md bg-ok-soft px-4 py-3 type-body text-ink">
          Solved. Reply below if it comes back, and we’ll pick it up again.
        </p>
      ) : (
        <p className="m-0 type-caption text-ink-2">
          We answer the same day
          {thread.replyTo === null ? '' : `, by email to ${thread.replyTo} and here`}.
        </p>
      )}
      <form
        noValidate
        aria-labelledby={`${ids}-reply`}
        onSubmit={(event) => void reply(event)}
        className="flex flex-col gap-3"
      >
        <h2 id={`${ids}-reply`} className="sr-only">
          Reply
        </h2>
        <Textarea
          label="Your reply"
          name="message"
          rows={4}
          maxLength={SUPPORT_MESSAGE_MAX}
          error={fieldError}
        />
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy !== null}>
            {busy === 'reply' ? 'Sending…' : 'Send reply'}
          </Button>
          {thread.status === 'solved' ? null : (
            <Button
              type="button"
              variant="quiet"
              disabled={busy !== null}
              onClick={() => void solve()}
            >
              {busy === 'solve' ? 'Marking…' : 'Mark as solved'}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
