'use client';

import type { BookingPaymentStart } from '@pepper/contracts';
import { Button } from '@pepper/ui';
import type { Stripe, StripeElements } from '@stripe/stripe-js';
import { useEffect, useRef, useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import { paymentWords } from '../../../lib/deposits';
import { Notice } from '../form-parts';

/**
 * The booking page's payment (S66.2, AC-X-122, ADR-0068): the terms in words first, then the card
 * goes into Stripe's own field (an iframe on Stripe's domain: Pepper never sees the card), or,
 * where the deployment's provider is the sandbox, a stand-in that settles the payment through the
 * dev route. Once Stripe says yes, `onPaid` books it; the api checks the payment with Stripe again.
 */
export function DepositStep({
  start,
  timeZone,
  policy = null,
  busy,
  onPaid,
}: {
  start: BookingPaymentStart;
  timeZone: string;
  /**
   * The business's cancellation policy (S67.2), said again where the card is kept (S68): a
   * no-show fee is charged to this card on the owner's OK, under these words.
   */
  policy?: string | null;
  /** While booking after the payment. */
  busy: boolean;
  onPaid: () => Promise<void>;
}) {
  const words = paymentWords(start, timeZone);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-lg bg-surface p-4" data-testid="deposit-terms">
        <h2 className="m-0 type-heading text-ink">{words.title}</h2>
        {words.lines.map((line) => (
          <p key={line} className="m-0 type-body text-ink-2">
            {line}
          </p>
        ))}
        {policy === null ? null : (
          <p className="m-0 type-body text-ink-2" data-testid="deposit-policy">
            {policy}
          </p>
        )}
      </div>
      {start.provider === 'sandbox' ? (
        <SandboxCard start={start} button={words.button} busy={busy} onPaid={onPaid} />
      ) : start.publishableKey === null ? (
        // Stripe without the key its field needs (a deployment's mistake): never the test card.
        <Notice tone="error">The card form can’t load right now. Try again later.</Notice>
      ) : (
        <StripeCard
          start={start}
          publishableKey={start.publishableKey}
          button={words.button}
          busy={busy}
          onPaid={onPaid}
        />
      )}
    </div>
  );
}

/** Stripe's Payment Element, loaded only on this step (D-2). */
function StripeCard({
  start,
  publishableKey,
  button,
  busy,
  onPaid,
}: {
  start: BookingPaymentStart;
  publishableKey: string;
  button: string;
  busy: boolean;
  onPaid: () => Promise<void>;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [stripe, setStripe] = useState<{ stripe: Stripe; elements: StripeElements } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    // An object, so the async loader reads the cleanup's change (a plain `let` reads as constant).
    const life = { gone: false };
    let unmount: (() => void) | null = null;
    void (async () => {
      try {
        // `pure`: Stripe's script loads now, not on every page that imports this file.
        const { loadStripe } = await import('@stripe/stripe-js/pure');
        const loaded = await loadStripe(publishableKey);
        if (life.gone || loaded === null || mountRef.current === null) {
          if (!life.gone) setState('failed');
          return;
        }
        const elements = loaded.elements({
          clientSecret: start.clientSecret,
          appearance: { theme: 'stripe' },
        });
        const field = elements.create('payment', { layout: 'tabs' });
        field.mount(mountRef.current);
        field.on('ready', () => {
          if (!life.gone) setState('ready');
        });
        unmount = () => {
          field.destroy();
        };
        setStripe({ stripe: loaded, elements });
      } catch {
        if (!life.gone) setState('failed');
      }
    })();
    return () => {
      life.gone = true;
      unmount?.();
    };
  }, [publishableKey, start.clientSecret]);

  async function pay(): Promise<void> {
    if (stripe === null) return;
    setPaying(true);
    setError(null);
    const options = {
      elements: stripe.elements,
      redirect: 'if_required' as const,
      // Only for a card that sends the client to their bank to approve it.
      confirmParams: { return_url: window.location.href },
    };
    const result =
      start.terms.kind === 'card'
        ? await stripe.stripe.confirmSetup(options)
        : await stripe.stripe.confirmPayment(options);
    setPaying(false);
    if (result.error !== undefined) {
      // Stripe's own words for a card problem ("Your card was declined.").
      setError(result.error.message ?? 'That card didn’t go through. Try another one.');
      return;
    }
    await onPaid();
  }

  return (
    <div className="flex flex-col gap-4">
      <div ref={mountRef} className="min-h-24 rounded-lg bg-surface p-4" />
      {state === 'loading' ? (
        <p className="m-0 type-caption text-ink-2" role="status">
          Loading the secure card form from Stripe…
        </p>
      ) : null}
      {state === 'failed' ? (
        <Notice tone="error">
          The card form didn’t load. Check your connection and reload the page.
        </Notice>
      ) : null}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <Button
        block
        size="lg"
        busy={paying || busy}
        disabled={state !== 'ready'}
        onClick={() => void pay()}
      >
        {paying || busy ? 'Booking…' : button}
      </Button>
      <p className="m-0 type-caption text-ink-2">Card details go to Stripe, never to us.</p>
    </div>
  );
}

/**
 * The sandbox's stand-in for Stripe's field (AC-X-120): a test card that pays, or one that is
 * declined, settled by the dev route. Only where the api's provider is the sandbox.
 */
function SandboxCard({
  start,
  button,
  busy,
  onPaid,
}: {
  start: BookingPaymentStart;
  button: string;
  busy: boolean;
  onPaid: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);

  async function settle(outcome: 'succeeded' | 'declined'): Promise<void> {
    setPaying(true);
    setError(null);
    const answer = await sendJson('POST', '/v1/dev/payments/intent', {
      clientSecret: start.clientSecret,
      outcome,
    });
    setPaying(false);
    if (!answer.ok) {
      setError('The test card didn’t go through. Try again.');
      return;
    }
    if (outcome === 'declined') {
      setError('Your card was declined. Try another card.');
      return;
    }
    await onPaid();
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-1 rounded-lg border border-dashed border-line-strong bg-surface p-4"
        data-testid="sandbox-card"
      >
        <p className="m-0 type-label text-ink">Test card · 4242 4242 4242 4242</p>
        <p className="m-0 type-caption text-ink-2">
          Sandbox: no real card and no real money. Stripe’s card form shows here in test and live
          mode.
        </p>
      </div>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <Button block size="lg" busy={paying || busy} onClick={() => void settle('succeeded')}>
        {paying || busy ? 'Booking…' : button}
      </Button>
      <Button variant="quiet" disabled={paying || busy} onClick={() => void settle('declined')}>
        Try a declined card
      </Button>
    </div>
  );
}
