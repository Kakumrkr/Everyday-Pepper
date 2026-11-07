'use client';

import {
  SAVED_REPLY_FIRST_NAME,
  SUPPORT_MESSAGE_MAX,
  SUPPORT_SAVED_REPLIES_MAX,
  SupportSavedReplySchema,
  type SupportSavedReply,
} from '@pepper/contracts';
import { Button, Input, Textarea } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { errorCodeOf, sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

type Busy = { kind: 'add' } | { kind: 'edit' | 'delete'; id: string } | null;

function byTitle(replies: readonly SupportSavedReply[]): SupportSavedReply[] {
  return [...replies].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** The title and text fields of a saved reply, checked before they are sent. */
function readReply(
  form: HTMLFormElement,
):
  | { ok: true; title: string; body: string }
  | { ok: false; field: 'title' | 'body'; error: string } {
  const title = formText(form, 'title');
  const body = formText(form, 'body');
  if (title === '') return { ok: false, field: 'title', error: 'Give it a title.' };
  if (body === '') return { ok: false, field: 'body', error: 'Write the reply.' };
  return { ok: true, title, body };
}

/**
 * The team's saved replies (S59.2.2, AC-X-23): a form to add one, then the list by title, each
 * editable and deletable (deleting asks once more). `{first name}` is filled in when a reply is
 * used in a request.
 */
export function OpsSavedReplies({ initial }: { initial: readonly SupportSavedReply[] }) {
  const ids = useId();
  const [replies, setReplies] = useState(() => byTitle(initial));
  const [busy, setBusy] = useState<Busy>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | undefined>>({});
  const full = replies.length >= SUPPORT_SAVED_REPLIES_MAX;

  /** A teammate deleted it meanwhile: it leaves the list too. */
  function gone(result: { status: number; body?: unknown }): boolean {
    return result.status === 404 && errorCodeOf(result.body) === 'saved_reply_not_found';
  }

  function fieldError(form: string, field: 'title' | 'body'): string | undefined {
    return fieldErrors[`${form}:${field}`];
  }

  async function save(event: SubmitEvent<HTMLFormElement>, id: string | null) {
    event.preventDefault();
    const form = event.currentTarget;
    const key = id ?? 'new';
    const read = readReply(form);
    if (!read.ok) {
      setFieldErrors({ [`${key}:${read.field}`]: read.error });
      form.querySelector<HTMLElement>(`[name="${read.field}"]`)?.focus();
      return;
    }
    setFieldErrors({});
    setError(null);
    setDone(null);
    setBusy(id === null ? { kind: 'add' } : { kind: 'edit', id });
    const result = await sendJson(
      id === null ? 'POST' : 'PUT',
      id === null ? '/v1/ops/replies' : `/v1/ops/replies/${id}`,
      { title: read.title, body: read.body },
    );
    setBusy(null);
    if (!result.ok) {
      if (id !== null && gone(result)) {
        setEditing(null);
        setReplies((current) => current.filter((reply) => reply.id !== id));
      }
      setError(result.message);
      return;
    }
    const saved = SupportSavedReplySchema.safeParse(result.data);
    if (!saved.success) {
      setError('Saved, but I couldn’t show it. Reload the page.');
      return;
    }
    setReplies((current) =>
      byTitle([...current.filter((reply) => reply.id !== saved.data.id), saved.data]),
    );
    setEditing(null);
    setDone(id === null ? `Saved “${saved.data.title}”.` : `Updated “${saved.data.title}”.`);
    if (id === null) form.reset();
  }

  async function remove(reply: SupportSavedReply) {
    setError(null);
    setDone(null);
    setBusy({ kind: 'delete', id: reply.id });
    const result = await sendJson('DELETE', `/v1/ops/replies/${reply.id}`, undefined);
    setBusy(null);
    setConfirming(null);
    if (!result.ok && !gone(result)) {
      setError(result.message);
      return;
    }
    setReplies((current) => current.filter((row) => row.id !== reply.id));
    setDone(`Deleted “${reply.title}”.`);
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="m-0 type-display">Saved replies</h1>
        <p className="m-0 type-body text-ink-2">
          Answers the team gives often. In a request, pick one and it lands in the reply box, with{' '}
          {SAVED_REPLY_FIRST_NAME} filled in, for you to edit and send.
        </p>
      </header>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {done === null ? null : <Notice tone="ok">{done}</Notice>}
      <section aria-labelledby={`${ids}-add`} className="flex flex-col gap-3">
        <h2 id={`${ids}-add`} className="m-0 type-title">
          Add a saved reply
        </h2>
        {full ? (
          <p className="m-0 type-body text-ink-2">
            That’s {SUPPORT_SAVED_REPLIES_MAX} saved replies: delete one you don’t use to add
            another.
          </p>
        ) : (
          <form
            noValidate
            onSubmit={(event) => void save(event, null)}
            className="flex flex-col gap-3"
          >
            <Input
              label="Title"
              hint="What the team picks it by, like “Calendar not syncing”."
              name="title"
              maxLength={80}
              error={fieldError('new', 'title')}
            />
            <Textarea
              label="Reply"
              hint={`Write ${SAVED_REPLY_FIRST_NAME} where their first name goes.`}
              name="body"
              rows={5}
              maxLength={SUPPORT_MESSAGE_MAX}
              error={fieldError('new', 'body')}
            />
            <div>
              <Button type="submit" disabled={busy !== null}>
                {busy?.kind === 'add' ? 'Saving…' : 'Save reply'}
              </Button>
            </div>
          </form>
        )}
      </section>
      <h2 id={`${ids}-list`} className="m-0 type-title">
        The team’s replies
      </h2>
      {replies.length === 0 ? (
        <p className="m-0 rounded-lg bg-surface-2 px-4 py-4 type-body text-ink-2">
          None yet. Add the answer you wrote most this week above.
        </p>
      ) : (
        <ul aria-labelledby={`${ids}-list`} className="m-0 flex list-none flex-col gap-3 p-0">
          {replies.map((reply) =>
            editing === reply.id ? (
              <li key={reply.id} className="rounded-lg border border-line bg-surface px-4 py-4">
                <form
                  noValidate
                  aria-label={`Edit “${reply.title}”`}
                  onSubmit={(event) => void save(event, reply.id)}
                  className="flex flex-col gap-3"
                >
                  <Input
                    label="Title"
                    name="title"
                    defaultValue={reply.title}
                    maxLength={80}
                    error={fieldError(reply.id, 'title')}
                  />
                  <Textarea
                    label="Reply"
                    name="body"
                    rows={5}
                    defaultValue={reply.body}
                    maxLength={SUPPORT_MESSAGE_MAX}
                    error={fieldError(reply.id, 'body')}
                  />
                  <div className="flex flex-wrap gap-3">
                    <Button type="submit" variant="secondary" disabled={busy !== null}>
                      {busy?.kind === 'edit' ? 'Saving…' : 'Save changes'}
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      disabled={busy !== null}
                      onClick={() => {
                        setEditing(null);
                        setFieldErrors({});
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              </li>
            ) : (
              <li
                key={reply.id}
                className="flex flex-col gap-2 rounded-lg border border-line bg-surface px-4 py-3"
              >
                <h2 className="m-0 type-label text-ink">{reply.title}</h2>
                <p className="m-0 line-clamp-3 type-body break-words whitespace-pre-wrap text-ink-2">
                  {reply.body}
                </p>
                {confirming === reply.id ? (
                  <div className="flex flex-wrap items-center gap-3" role="group">
                    <span className="type-label text-ink">Delete it for the whole team?</span>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void remove(reply)}
                    >
                      {busy?.kind === 'delete' ? 'Deleting…' : 'Delete'}
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Keep it
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      disabled={busy !== null}
                      aria-label={`Edit “${reply.title}”`}
                      onClick={() => {
                        setEditing(reply.id);
                        setConfirming(null);
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      type="button"
                      variant="quiet"
                      size="sm"
                      disabled={busy !== null}
                      aria-label={`Delete “${reply.title}”`}
                      onClick={() => {
                        setConfirming(reply.id);
                        setEditing(null);
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
