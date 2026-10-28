'use client';

import { Button } from '@pepper/ui';
import { useEffect, useState } from 'react';
import { ROUTES, confirmedUrl } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

/** How long "Send again" waits between sends, in seconds (the api allows 3 a minute). */
export const RESEND_WAIT_SECONDS = 30;

/**
 * "Check your inbox" after a sign-up or an unconfirmed sign-in (S44, AC-W1-5): the address the
 * link went to, and "Send again" as the main action at the bottom, which waits a little between
 * sends. The link signs them in and goes on to `next`.
 */
export function CheckInbox({
  email,
  next = null,
  resent = false,
}: {
  email: string;
  next?: string | null;
  /** A sign-in that found the email unconfirmed has just sent a new link. */
  resent?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState(resent ? RESEND_WAIT_SECONDS : 0);
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => {
      setWait((left) => left - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [wait]);

  async function sendAgain() {
    setBusy(true);
    setResult(null);
    const sent = await sendJson('POST', '/api/auth/send-verification-email', {
      email,
      callbackURL: confirmedUrl(next),
    });
    setBusy(false);
    if (!sent.ok) {
      setResult({ tone: 'error', text: sent.message });
      return;
    }
    setWait(RESEND_WAIT_SECONDS);
    setResult({ tone: 'ok', text: 'Sent again. It can take a minute, and may land in spam.' });
  }

  return (
    <AuthPage
      title="Check your inbox"
      lead={
        <>
          {resent ? 'Your email isn’t confirmed yet. We sent a new link to ' : 'We sent a link to '}
          <span className="font-semibold break-all text-ink">{email}</span>. Open it to finish
          setting up Pepper.
        </>
      }
      action={
        <Button size="lg" block busy={busy} disabled={wait > 0} onClick={() => void sendAgain()}>
          {busy ? 'Sending…' : wait > 0 ? `Send again in ${String(wait)} s` : 'Send the link again'}
        </Button>
      }
    >
      {result === null ? null : <Notice tone={result.tone}>{result.text}</Notice>}
      <p className="m-0 type-body text-ink-2">
        The link works for 24 hours. Wrong email?{' '}
        <TextLink href={ROUTES.signUp}>Start again</TextLink>
      </p>
      <p className="m-0 type-body text-ink-2">
        Already confirmed? <TextLink href={ROUTES.signIn}>Sign in</TextLink>
      </p>
    </AuthPage>
  );
}
