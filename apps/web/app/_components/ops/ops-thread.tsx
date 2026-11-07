'use client';

import {
  OperatorThreadSchema,
  SUPPORT_MESSAGE_MAX,
  type OperatorThread,
  type SupportStatus,
} from '@pepper/contracts';
import { Badge, Button, cx, DetailTable, Segmented, Textarea } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { OPS_THREAD_STATUS } from '../../../lib/ops';
import { SUPPORT_KIND_LABEL, supportTime } from '../../../lib/support';
import { Notice } from '../form-parts';
import { OpsNotes } from './ops-notes';

const STATUSES: readonly { value: SupportStatus; label: string }[] = [
  { value: 'waiting_on_pepper', label: 'Waiting on us' },
  { value: 'pepper_replied', label: 'We replied' },
  { value: 'solved', label: 'Solved' },
];

function isStatus(value: string): value is SupportStatus {
  return STATUSES.some((status) => status.value === value);
}

/**
 * A business's request in the console (S59.2, AC-X-21): who sent it and with what, the
 * conversation (the business on the left, the team on the right), the reply that reaches the
 * requester, the team's notes, and every status.
 */
export function OpsThreadView({ initial }: { initial: OperatorThread }) {
  const ids = useId();
  const [thread, setThread] = useState(initial);
  const [busy, setBusy] = useState<'reply' | 'note' | 'status' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [now] = useState(() => Date.now());
  const status = OPS_THREAD_STATUS[thread.status];

  async function call(
    kind: 'reply' | 'note' | 'status',
    method: 'POST' | 'PATCH',
    path: string,
    body: object,
  ): Promise<boolean> {
    setError(null);
    setBusy(kind);
    const result = await sendJson(method, path, body);
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return false;
    }
    const parsed = OperatorThreadSchema.safeParse(result.data);
    if (!parsed.success) {
      setError('Done, but I couldn’t show it. Reload the page.');
      return false;
    }
    setThread(parsed.data);
    return true;
  }

  async function reply(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = formText(form, 'message');
    if (message === '') {
      setFieldError('Write the reply first.');
      form.querySelector<HTMLElement>('[name="message"]')?.focus();
      return;
    }
    setFieldError(undefined);
    if (await call('reply', 'POST', `/v1/ops/threads/${thread.id}/messages`, { message })) {
      form.reset();
    }
  }

  const context = thread.context;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-title">{SUPPORT_KIND_LABEL[thread.kind]}</h1>
        <p className="m-0 flex flex-wrap items-center gap-2 type-caption text-ink-2">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="tabular-nums" data-testid="ops-thread-reference">
            {thread.reference}
          </span>
          <span>· {thread.business}</span>
          <span>
            ·{' '}
            {thread.openedBy === null
              ? 'A former team member'
              : `${thread.openedBy.name}${thread.openedBy.role === null ? '' : `, ${thread.openedBy.role}`}`}
          </span>
        </p>
      </header>
      {context === null ? null : (
        <details className="rounded-lg bg-surface-2 px-4 py-2">
          <summary className="min-h-11 cursor-pointer content-center type-label text-ink">
            Sent with
          </summary>
          <DetailTable
            rows={[
              { label: 'Page', value: context.page ?? '—' },
              { label: 'Article', value: context.topic ?? '—' },
              { label: 'Error', value: context.errorRef ?? '—' },
              { label: 'Version', value: context.appVersion },
              { label: 'Browser', value: context.userAgent ?? '—' },
              {
                label: 'Setup',
                value: `${context.setup.bookable ? 'Bookable' : 'Not bookable yet'}, ${context.setup.firstBooking ? 'has a booking' : 'no booking yet'}`,
              },
            ]}
          />
        </details>
      )}
      <ol aria-label="Messages" className="m-0 flex list-none flex-col gap-3 p-0">
        {thread.messages.map((message) => {
          const pepper = message.author.kind === 'pepper';
          return (
            <li
              key={message.id}
              className={cx('flex flex-col gap-1', pepper ? 'items-end' : 'items-start')}
            >
              <span className="type-caption text-ink-2">
                <span className="font-semibold text-ink">
                  {message.author.kind === 'pepper'
                    ? 'Pepper team'
                    : (message.author.name ?? 'A former team member')}
                </span>{' '}
                ·{' '}
                <span className="tabular-nums">
                  {supportTime(message.createdAt, 'UTC', now)} UTC
                </span>
              </span>
              <p
                className={cx(
                  'm-0 max-w-11/12 rounded-lg px-4 py-3 type-body break-words whitespace-pre-wrap text-ink',
                  pepper ? 'bg-brand-soft' : 'border border-line bg-surface',
                )}
              >
                {message.body}
              </p>
            </li>
          );
        })}
      </ol>
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
          label="Reply to the business"
          hint="They see it in the app and by email."
          name="message"
          rows={4}
          maxLength={SUPPORT_MESSAGE_MAX}
          error={fieldError}
        />
        <div>
          <Button type="submit" disabled={busy !== null}>
            {busy === 'reply' ? 'Sending…' : 'Send reply'}
          </Button>
        </div>
      </form>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <section aria-labelledby={`${ids}-status`} className="flex flex-col gap-2">
        <h2 id={`${ids}-status`} className="m-0 type-label text-ink-2">
          Status
        </h2>
        <Segmented
          label="Status"
          options={STATUSES}
          value={thread.status}
          onValueChange={(next) => {
            if (busy === null && isStatus(next)) {
              void call('status', 'PATCH', `/v1/ops/threads/${thread.id}`, { status: next });
            }
          }}
        />
      </section>
      <OpsNotes
        notes={thread.notes}
        now={now}
        busy={busy === 'note'}
        onAdd={(note) => call('note', 'POST', `/v1/ops/threads/${thread.id}/notes`, { note })}
      />
    </div>
  );
}
