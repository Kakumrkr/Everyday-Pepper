'use client';

import { PushKeyResponseSchema, PushStatusResponseSchema } from '@pepper/contracts';
import { Button } from '@pepper/ui';
import { useEffect, useId, useMemo, useState } from 'react';
import { fetchJson, sendJson } from '../../../lib/client-api';
import {
  readPushState,
  realBrowser,
  turnPushOff,
  turnPushOn,
  type PushApi,
  type PushState,
} from '../../../lib/push';
import { Notice } from '../booking/sheet';

/** What the card says in each state. */
const TEXT: Record<Exclude<PushState, 'unavailable'>, string> = {
  unsupported: 'This browser can’t show notifications. Try the installed app.',
  'install-first':
    'On iPhone and iPad, add Pepper to your Home Screen first (Share → Add to Home Screen), then open it from there.',
  blocked:
    'Notifications are blocked for Pepper in this browser. Allow them in the browser’s settings.',
  off: 'Get a notification when a client books, moves or cancels on your booking page, and when a to-do is due.',
  on: 'This device gets notifications from this business.',
};

/** The api calls the switch makes (`/v1/push`). */
const api: PushApi = {
  status: async (endpoint) => {
    const answer = await sendJson('POST', '/v1/push/subscription/status', { endpoint });
    const parsed = answer.ok ? PushStatusResponseSchema.safeParse(answer.data) : null;
    return parsed?.success === true && parsed.data.subscribed;
  },
  save: async (subscription) => (await sendJson('PUT', '/v1/push/subscription', subscription)).ok,
  remove: async (endpoint) => (await sendJson('DELETE', '/v1/push/subscription', { endpoint })).ok,
};

/**
 * Notifications on this device (S21, ADR-0026), in More's settings (S41): one switch per device
 * and business.
 * Hidden when the deployment sends no pushes. Pushes never name a client.
 */
export function NotificationsCard() {
  const headingId = useId();
  const browser = useMemo(() => realBrowser(), []);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      const key = await fetchJson('/v1/push/key', PushKeyResponseSchema);
      const found = key.ok ? key.data.publicKey : null;
      const next = await readPushState(browser, api, found).catch((): PushState => 'unsupported');
      if (run.cancelled) return;
      setPublicKey(found);
      setState(next);
    })();
    return () => {
      run.cancelled = true;
    };
  }, [browser]);

  async function toggle(on: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const next =
        on && publicKey !== null
          ? await turnPushOn(browser, api, publicKey)
          : await turnPushOff(browser, api);
      setState(next);
      if (on && next === 'off') setError('Notifications weren’t turned on. Try again.');
    } catch {
      setError('Notifications couldn’t be changed on this device. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'loading' || state === 'unavailable') return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col items-start gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="m-0 type-subheading">
          Notifications on this device
        </h2>
        <p className="m-0 type-body text-ink-2" data-testid="push-state" data-state={state}>
          {TEXT[state]}
        </p>
      </div>
      {state === 'off' ? (
        <Button size="sm" busy={busy} onClick={() => void toggle(true)}>
          Turn on notifications
        </Button>
      ) : null}
      {state === 'on' ? (
        <Button variant="secondary" size="sm" busy={busy} onClick={() => void toggle(false)}>
          Turn off
        </Button>
      ) : null}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
    </section>
  );
}
