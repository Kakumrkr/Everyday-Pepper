'use client';

import { CLIENT_TEXT_REPLY_MAX, type FeedInsight, type FeedItem } from '@pepper/contracts';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Receipt } from '../kit/blocks.js';
import { Button, buttonStyle } from '../kit/button.js';
import { Textarea } from '../kit/fields.js';
import { clientTextOutcomeLine, clockTime, feedLine } from './feed-lines.js';

// Clients' own texts on Home (S80, ADR-0072, AC-X-232, AC-X-233): one raised card a client a
// day for owners and managers, quoting the latest text (shown as the client wrote it, never
// inside Pepper's sentences), naming the visit it's likely about beside it (once read, S81a.2:
// the visit it was about, and what Pepper did), with Reply (a text in the
// member's words, from the business), "Open {client}" and Done. A reply queued shows a receipt
// with Undo until it goes. The profile reuses the reply box (`ClientTextReplyBox`). Every
// sentence but the quote comes from `feedLine`.

export type ClientTextItem = FeedItem & Extract<FeedInsight, { kind: 'client_text' }>;

/** What a reply came to: queued (with when it goes), or a message to show. */
export type ClientTextReplyResult =
  { ok: true; replyId: string; sendsAt: string } | { ok: false; message: string };

/** What Undo came to: taken back, too late (it went), or a message to show. */
export type ClientTextUndoResult = 'taken_back' | 'too_late' | { error: string };

export interface ClientTextCardsProps {
  items: readonly ClientTextItem[];
  /** The business's name, as the reply's text starts with it. */
  businessName: string;
  timeZone: string;
  now: number;
  onReply: (item: ClientTextItem, body: string) => Promise<ClientTextReplyResult>;
  onUndo: (item: ClientTextItem, replyId: string) => Promise<ClientTextUndoResult>;
  /** "Done": the card closes (`null`) or says why not. */
  onDone: (item: ClientTextItem) => Promise<string | null>;
  /** The link to the client's profile ("Open Maria"), the app's router link. */
  renderClientLink: (item: ClientTextItem) => ReactNode;
}

/** Nothing to show without texts: the section only appears when a client texted. */
export function ClientTextCards({ items, ...rest }: ClientTextCardsProps) {
  const headingId = useId();
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 type-heading">
        Texts from clients
      </h2>
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {items.map((item) => (
          <li key={item.id}>
            <ClientTextCard item={item} {...rest} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface Queued {
  replyId: string;
  sendsAt: string;
  /** Within a minute (the hold for Undo); else when the quiet hours end. */
  soon: boolean;
}

type ReplyState =
  | { step: 'idle' }
  | { step: 'writing'; body: string; error: string | null; busy: boolean }
  | { step: 'queued'; queued: Queued };

/** The reply's steps: write, send (queued), and back to idle when Undo takes it back. */
function useReply(onReply: (body: string) => Promise<ClientTextReplyResult>) {
  const [state, setState] = useState<ReplyState>({ step: 'idle' });
  const send = async (body: string) => {
    setState({ step: 'writing', body, error: null, busy: true });
    const result = await onReply(body.trim());
    if (result.ok) {
      const soon = Date.parse(result.sendsAt) - Date.now() < 60_000;
      setState({
        step: 'queued',
        queued: { replyId: result.replyId, sendsAt: result.sendsAt, soon },
      });
    } else {
      setState({ step: 'writing', body, error: result.message, busy: false });
    }
  };
  return { state, setState, send };
}

function ClientTextCard({
  item,
  businessName,
  timeZone,
  now,
  onReply,
  onUndo,
  onDone,
  renderClientLink,
}: Omit<ClientTextCardsProps, 'items'> & { item: ClientTextItem }) {
  const titleId = useId();
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { state, setState, send } = useReply((body) => onReply(item, body));
  const line = feedLine(item, timeZone, now);
  const done = clientTextOutcomeLine(item, timeZone);
  const client = item.names.client ?? 'this client';
  if (closed) return null;

  if (state.step === 'queued') {
    return (
      <article
        aria-labelledby={titleId}
        className="flex flex-col gap-3 rounded-lg bg-surface p-5 shadow-raised"
        data-testid="client-text-card"
      >
        <h3 id={titleId} className="sr-only">
          {line.title}
        </h3>
        <QueuedReceipt
          client={client}
          timeZone={timeZone}
          queued={state.queued}
          onUndo={() => onUndo(item, state.queued.replyId)}
          onTakenBack={() => {
            setState({ step: 'idle' });
          }}
        />
      </article>
    );
  }

  return (
    <article
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg bg-surface p-5 shadow-raised"
      data-testid="client-text-card"
    >
      <h3 id={titleId} className="m-0 type-subheading">
        {line.title}
      </h3>
      <blockquote
        className="m-0 rounded-md bg-surface-2 px-4 py-3 type-body break-words whitespace-pre-wrap text-ink"
        data-testid="client-text-quote"
      >
        {item.payload.body}
      </blockquote>
      <p className="m-0 type-body text-ink-2" data-testid="client-text-visit">
        {line.why}
      </p>
      {done === null ? null : (
        <p className="m-0 type-body text-ink" data-testid="client-text-outcome">
          {done}
        </p>
      )}
      {state.step === 'writing' ? (
        <ReplyForm
          client={client}
          businessName={businessName}
          state={state}
          onChange={(body) => {
            setState({ ...state, body, error: null });
          }}
          onSend={(body) => void send(body)}
          onCancel={() => {
            setState({ step: 'idle' });
          }}
        />
      ) : (
        <div className="mt-1 flex flex-wrap gap-2">
          <Button
            size="sm"
            icon="send"
            onClick={() => {
              setError(null);
              setState({ step: 'writing', body: '', error: null, busy: false });
            }}
          >
            Reply
          </Button>
          {renderClientLink(item)}
          <button
            type="button"
            className={buttonStyle({ variant: 'quiet', size: 'sm' })}
            onClick={() => {
              setError(null);
              void onDone(item).then((failed) => {
                if (failed === null) setClosed(true);
                else setError(failed);
              });
            }}
          >
            Done
          </button>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="m-0 type-body text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

export interface ClientTextReplyBoxProps {
  clientName: string;
  businessName: string;
  timeZone: string;
  onReply: (body: string) => Promise<ClientTextReplyResult>;
  onUndo: (replyId: string) => Promise<ClientTextUndoResult>;
}

/** Reply by text from the client's profile (S80): the card's reply box, on its own. */
export function ClientTextReplyBox({
  clientName,
  businessName,
  timeZone,
  onReply,
  onUndo,
}: ClientTextReplyBoxProps) {
  const { state, setState, send } = useReply(onReply);
  switch (state.step) {
    case 'idle':
      return (
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon="send"
            onClick={() => {
              setState({ step: 'writing', body: '', error: null, busy: false });
            }}
          >
            Reply by text
          </Button>
        </div>
      );
    case 'writing':
      return (
        <ReplyForm
          client={clientName}
          businessName={businessName}
          state={state}
          onChange={(body) => {
            setState({ ...state, body, error: null });
          }}
          onSend={(body) => void send(body)}
          onCancel={() => {
            setState({ step: 'idle' });
          }}
        />
      );
    case 'queued':
      return (
        <QueuedReceipt
          client={clientName}
          timeZone={timeZone}
          queued={state.queued}
          onUndo={() => onUndo(state.queued.replyId)}
          onTakenBack={() => {
            setState({ step: 'idle' });
          }}
        />
      );
  }
}

/**
 * A queued reply's receipt: Undo until it goes (the button leaves once its time passes, or when
 * Undo finds it already went: then it says so).
 */
function QueuedReceipt({
  client,
  timeZone,
  queued,
  onUndo,
  onTakenBack,
}: {
  client: string;
  timeZone: string;
  queued: Queued;
  onUndo: () => Promise<ClientTextUndoResult>;
  onTakenBack: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // Past its time (and a few seconds for the worker), Undo can no longer take it back.
    const wait = Math.max(0, Date.parse(queued.sendsAt) - Date.now() + 5_000);
    const timer = setTimeout(() => {
      setSent(true);
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [queued.sendsAt]);
  const at = clockTime(queued.sendsAt, timeZone);
  return (
    <div className="flex flex-col gap-2">
      <Receipt
        undo={
          sent
            ? undefined
            : {
                until: queued.soon ? 'it goes' : at,
                onUndo: () => {
                  setError(null);
                  void onUndo().then((result) => {
                    if (result === 'taken_back') onTakenBack();
                    else if (result === 'too_late') setSent(true);
                    else setError(result.error);
                  });
                },
              }
        }
      >
        {sent
          ? `Reply to ${client} sent by text.`
          : queued.soon
            ? `Reply to ${client} goes by text in a few seconds.`
            : `Reply to ${client} waits for the morning. It goes at ${at}.`}
      </Receipt>
      {error === null ? null : (
        <p role="alert" className="m-0 type-body text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ReplyForm({
  client,
  businessName,
  state,
  onChange,
  onSend,
  onCancel,
}: {
  client: string;
  businessName: string;
  state: Extract<ReplyState, { step: 'writing' }>;
  onChange: (body: string) => void;
  onSend: (body: string) => void;
  onCancel: () => void;
}) {
  const left = CLIENT_TEXT_REPLY_MAX - state.body.length;
  const empty = state.body.trim().length === 0;
  return (
    <form
      className="mt-1 flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty) onSend(state.body);
      }}
    >
      <Textarea
        label={`Your reply to ${client}`}
        hint={`Goes by text from ${businessName}. Quiet hours hold it until 8:00 AM.`}
        value={state.body}
        maxLength={CLIENT_TEXT_REPLY_MAX}
        // The field opens for writing: focus moves into it.
        autoFocus
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...(state.error === null ? {} : { error: state.error })}
      />
      <p className="m-0 type-caption text-ink-3 tabular-nums" aria-live="polite">
        {`${String(left)} characters left`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" busy={state.busy} disabled={empty}>
          Send reply
        </Button>
        <button
          type="button"
          className={buttonStyle({ variant: 'quiet', size: 'sm' })}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
