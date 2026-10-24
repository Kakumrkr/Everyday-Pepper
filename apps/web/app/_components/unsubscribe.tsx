'use client';

import { UnsubscribeResponseSchema, type UnsubscribeResponse } from '@pepper/contracts';
import { buttonClass, Card } from '@pepper/ui';
import { useEffect, useId, useState } from 'react';
import { fetchJson, sendJson } from '../../lib/client-api';

type State =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ready'; page: UnsubscribeResponse }
  | { kind: 'error'; message: string };

/**
 * One-click unsubscribe from a business's rebooking emails (S36): the page names the business,
 * and the button stops them. Booking confirmations and reminders still come.
 */
export function Unsubscribe({ token }: { token: string }) {
  const headingId = useId();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const path = `/v1/public/unsubscribe/${encodeURIComponent(token)}`;

  useEffect(() => {
    void fetchJson(path, UnsubscribeResponseSchema).then((answer) => {
      setState(answer.ok ? { kind: 'ready', page: answer.data } : { kind: 'invalid' });
    });
  }, [path]);

  async function unsubscribe(): Promise<void> {
    setBusy(true);
    const answer = await sendJson('POST', path, {});
    setBusy(false);
    const page = answer.ok ? UnsubscribeResponseSchema.safeParse(answer.data) : null;
    if (page?.success === true) setState({ kind: 'ready', page: page.data });
    else setState({ kind: 'error', message: answer.ok ? 'Something went wrong.' : answer.message });
  }

  return (
    <Card labelledBy={headingId} className="flex flex-col gap-3">
      <h1 id={headingId} className="m-0 text-xl font-bold">
        Unsubscribe
      </h1>
      {state.kind === 'loading' ? (
        <p className="m-0 text-ink-2">One moment…</p>
      ) : state.kind === 'invalid' ? (
        <p className="m-0">
          This unsubscribe link isn’t valid. Contact the business if you keep getting emails.
        </p>
      ) : state.kind === 'error' ? (
        <p role="alert" className="m-0 text-danger">
          {state.message}
        </p>
      ) : state.page.unsubscribed ? (
        <p role="status" className="m-0" data-testid="unsubscribed">
          You won’t get rebooking emails from {state.page.businessName} any more. Booking
          confirmations and reminders still come.
        </p>
      ) : (
        <>
          <p className="m-0">
            Stop rebooking emails from {state.page.businessName}? Booking confirmations and
            reminders will still come.
          </p>
          <div>
            <button
              type="button"
              disabled={busy}
              className={buttonClass()}
              onClick={() => void unsubscribe()}
            >
              Unsubscribe
            </button>
          </div>
        </>
      )}
    </Card>
  );
}
