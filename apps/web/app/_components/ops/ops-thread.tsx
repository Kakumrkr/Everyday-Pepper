'use client';

import {
  OperatorThreadSchema,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_QUIET_DAYS,
  type OperatorThread,
  type SupportSavedReply,
  type SupportStatus,
} from '@pepper/contracts';
import { Badge, Button, cx, DetailTable, Icon, Segmented, Select, Textarea } from '@pepper/ui';
import { useId, useRef, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { fillSavedReply, OPS_RATING, OPS_THREAD_STATUS } from '../../../lib/ops';
import { SUPPORT_KIND_LABEL, supportTime } from '../../../lib/support';
import { opsScreenshotSrc } from '../../../lib/support-screenshots';
import { Notice } from '../form-parts';
import { SupportMessageMeta } from '../support/message-meta';
import { MessageScreenshots } from '../support/message-screenshots';
import { OpsNotes } from './ops-notes';

const STATUSES: readonly { value: SupportStatus; label: string }[] = Object.entries(
  OPS_THREAD_STATUS,
).map(([value, { label }]) => ({ value: value as SupportStatus, label }));

function isStatus(value: string): value is SupportStatus {
  return STATUSES.some((status) => status.value === value);
}

/**
 * A business's request in the console (S59.2, AC-X-21): who sent it and with what, the
 * conversation (the business on the left, the team on the right), the reply that reaches the
 * requester (a saved reply may start it, S59.2.2), the team's notes, and every status; once
 * solved, how and whether it helped (AC-X-24/26).
 */
export function OpsThreadView({
  initial,
  savedReplies,
}: {
  initial: OperatorThread;
  savedReplies: readonly SupportSavedReply[];
}) {
  const ids = useId();
  const replyForm = useRef<HTMLFormElement>(null);
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

  /**
   * Puts a saved reply in the reply box for the operator to edit and send (AC-X-23): below what
   * they have already written, never over it; too long once the name is in, it says so.
   */
  function applySaved(replyId: string) {
    const saved = savedReplies.find((reply) => reply.id === replyId);
    const box = replyForm.current?.elements.namedItem('message');
    if (saved === undefined || !(box instanceof HTMLTextAreaElement)) return;
    const filled = fillSavedReply(saved.body, thread.openedBy?.name ?? null);
    const draft = box.value.trimEnd();
    const next = draft === '' ? filled : `${draft}\n\n${filled}`;
    if (next.length > SUPPORT_MESSAGE_MAX) {
      setFieldError(
        `That would make the reply longer than ${String(SUPPORT_MESSAGE_MAX)} characters. Shorten it first.`,
      );
      box.focus();
      return;
    }
    box.value = next;
    setFieldError(undefined);
    box.focus();
  }

  const context = thread.context;
  const rating = thread.rating === null ? null : OPS_RATING[thread.rating];
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
          {thread.solvedBy === 'auto' ? (
            <span>· Closed after {SUPPORT_QUIET_DAYS} quiet days</span>
          ) : null}
          {rating === null ? null : (
            <Badge tone={rating.tone}>
              <Icon
                name={thread.rating === 'helpful' ? 'thumbUp' : 'thumbDown'}
                className="size-4"
              />
              {rating.label}
            </Badge>
          )}
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
              <SupportMessageMeta
                who={
                  message.author.kind === 'pepper'
                    ? 'Pepper team'
                    : (message.author.name ?? 'A former team member')
                }
                when={`${supportTime(message.createdAt, 'UTC', now)} UTC`}
                byEmail={message.channel === 'email'}
              />
              <p
                className={cx(
                  'm-0 max-w-11/12 rounded-lg px-4 py-3 type-body break-words whitespace-pre-wrap text-ink',
                  pepper ? 'bg-brand-soft' : 'border border-line bg-surface',
                )}
              >
                {message.body}
              </p>
              <MessageScreenshots
                screenshots={message.screenshots}
                from={
                  message.author.kind === 'pepper'
                    ? 'Pepper team'
                    : (message.author.name ?? 'a former team member')
                }
                src={opsScreenshotSrc}
                align={pepper ? 'end' : 'start'}
              />
            </li>
          );
        })}
      </ol>
      <form
        ref={replyForm}
        noValidate
        aria-labelledby={`${ids}-reply`}
        onSubmit={(event) => void reply(event)}
        className="flex flex-col gap-3"
      >
        <h2 id={`${ids}-reply`} className="sr-only">
          Reply
        </h2>
        {/* The same picker whatever the team has saved (added under "Saved replies"). */}
        <Select
          label="Use a saved reply"
          hint="It goes in the box below for you to edit."
          value=""
          options={[
            { value: '', label: 'Choose one' },
            ...savedReplies.map((saved) => ({ value: saved.id, label: saved.title })),
          ]}
          onChange={(event) => {
            applySaved(event.currentTarget.value);
          }}
        />
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
