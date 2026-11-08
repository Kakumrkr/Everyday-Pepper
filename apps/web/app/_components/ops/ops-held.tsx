'use client';

import { OperatorHeldListSchema, type OperatorHeldList } from '@pepper/contracts';
import { Badge, Button, EmptyState } from '@pepper/ui';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { OPS_HELD_REASON, OPS_PATHS, waitedFor } from '../../../lib/ops';
import { kitLink } from '../kit-link';
import { Notice } from '../form-parts';

/**
 * The held review (S59.3.2, AC-X-44): who sent each email, why it waits, its text as plain text
 * (never rendered), and Accept or Discard. Accept lands it as if its check had passed (a reply
 * from outside the business becomes the team's note on its request); Discard empties it.
 */
export function OpsHeldList({ initial }: { initial: OperatorHeldList }) {
  const [held, setHeld] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  async function decide(id: string, decision: 'accept' | 'discard') {
    setError(null);
    setDone(null);
    setBusy(id);
    const result = await sendJson('POST', `/v1/ops/held/${id}`, { decision });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    const parsed = OperatorHeldListSchema.safeParse(result.data);
    if (!parsed.success) {
      setError('Done, but I couldn’t show it. Reload the page.');
      return;
    }
    setHeld(parsed.data);
    setDone(
      decision === 'accept'
        ? 'Accepted: it lands within a minute.'
        : 'Discarded: nothing was kept.',
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite">
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        {done === null ? null : <Notice tone="ok">{done}</Notice>}
      </div>
      {held.items.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing held"
          body="Every email we got was checked. Anything we can’t check waits here for a look."
          action={{ label: 'Back to the inbox', href: OPS_PATHS.inbox, renderLink: kitLink }}
        />
      ) : (
        <ol aria-label="Held mail" className="m-0 flex list-none flex-col gap-3 p-0">
          {held.items.map((item) => (
            <li
              key={item.id}
              data-testid="ops-held-item"
              className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3"
            >
              <div className="flex flex-col gap-1">
                <p className="m-0 type-label break-all text-ink">{item.from}</p>
                <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-2">
                  <Badge tone="warn">{OPS_HELD_REASON[item.reason]}</Badge>
                  <span className="tabular-nums">{waitedFor(item.heldSince, now)} ago</span>
                  <span>
                    ·{' '}
                    {item.kind === 'reply'
                      ? `A reply to ${item.reference ?? 'a request'}`
                      : 'A new request'}
                  </span>
                  <span>· {item.business ?? 'No business: a signed-out request'}</span>
                </p>
              </div>
              {item.subject === null ? null : (
                <p className="m-0 type-label break-words text-ink">{item.subject}</p>
              )}
              <p className="m-0 max-h-48 overflow-y-auto rounded-md bg-surface-2 px-3 py-2 type-body break-words whitespace-pre-wrap text-ink">
                {item.text}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide(item.id, 'accept')}
                >
                  {busy === item.id ? 'Working…' : 'Accept'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy !== null}
                  onClick={() => void decide(item.id, 'discard')}
                >
                  Discard
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
