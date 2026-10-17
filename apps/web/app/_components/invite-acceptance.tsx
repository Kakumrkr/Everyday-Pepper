'use client';

import type { AcceptInviteResponse, InvitePreviewResponse, InviteToken } from '@floty/contracts';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ROUTES, withNext } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { INVITE_TOKEN_KEY, inviteTokenFromHash } from '../../lib/invite';
import { SignOutButton } from './account-actions';
import { FormError } from './form-error';

type State =
  | { step: 'reading' }
  | { step: 'no-token' }
  | { step: 'signed-out' }
  | { step: 'looking-up' }
  | { step: 'ready'; token: InviteToken; preview: InvitePreviewResponse }
  | { step: 'failed'; message: string; wrongAccount: boolean };

const ROLE_NAMES = { owner: 'an owner', manager: 'a manager', staff: 'a team member' } as const;

/** Reads the link's token and keeps it for this tab while the visitor signs in or up. */
function takeToken(): InviteToken | null {
  const fromLink = inviteTokenFromHash(window.location.hash);
  try {
    if (fromLink !== null) {
      sessionStorage.setItem(INVITE_TOKEN_KEY, fromLink);
      // Out of the address bar, history and anything copied from it.
      history.replaceState(null, '', window.location.pathname);
      return fromLink;
    }
    return inviteTokenFromHash(sessionStorage.getItem(INVITE_TOKEN_KEY) ?? '');
  } catch {
    return fromLink;
  }
}

function forgetToken(): void {
  try {
    sessionStorage.removeItem(INVITE_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/**
 * Accepting an invite (ADR-0014): signed out, it asks to sign in or create an account with
 * the invited email, then comes back here; signed in, it shows the business and joins it.
 */
export function InviteAcceptance({ email }: { email: string | null }) {
  const [state, setState] = useState<State>({ step: 'reading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = takeToken();
    if (token === null) {
      setState({ step: 'no-token' });
      return;
    }
    if (email === null) {
      setState({ step: 'signed-out' });
      return;
    }
    setState({ step: 'looking-up' });
    void sendJson<InvitePreviewResponse>('POST', '/v1/invites/lookup', { token }).then((result) => {
      if (result.ok) {
        setState({ step: 'ready', token, preview: result.data });
        return;
      }
      // A wrong account may still be fixed by signing in as the right one; keep the token.
      const wrongAccount = result.status === 403;
      if (!wrongAccount) forgetToken();
      setState({ step: 'failed', message: result.message, wrongAccount });
    });
  }, [email]);

  async function join(token: InviteToken) {
    setBusy(true);
    setError(null);
    const result = await sendJson<AcceptInviteResponse>('POST', '/v1/invites/accept', { token });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    forgetToken();
    // Home routes managers and owners to two-step setup first.
    window.location.assign(ROUTES.home);
  }

  switch (state.step) {
    case 'reading':
    case 'looking-up':
      return <p className="tagline">Opening your invite…</p>;
    case 'no-token':
      return (
        <p className="tagline" role="alert">
          This invite link is incomplete. Open the link from your invite again.
        </p>
      );
    case 'signed-out':
      return (
        <section aria-labelledby="invite-heading" className="form">
          <h2 id="invite-heading">You’re invited to join a business on Floty</h2>
          <p className="hint">
            Create an account or sign in with the email address the invite was sent to.
          </p>
          <Link className="button" href={withNext(ROUTES.signUp, ROUTES.invite)}>
            Create an account
          </Link>
          <Link className="button secondary" href={withNext(ROUTES.signIn, ROUTES.invite)}>
            Sign in
          </Link>
        </section>
      );
    case 'failed':
      return (
        <section aria-labelledby="invite-heading" className="form">
          <h2 id="invite-heading">This invite can’t be used</h2>
          <FormError message={state.message} />
          {state.wrongAccount ? (
            <>
              <p className="hint">You’re signed in as {email}.</p>
              <SignOutButton next={ROUTES.invite} label="Sign in with another email" />
            </>
          ) : (
            <Link href={ROUTES.home}>Go to Floty</Link>
          )}
        </section>
      );
    case 'ready': {
      const { preview, token } = state;
      return (
        <section aria-labelledby="invite-heading" className="form">
          <h2 id="invite-heading">Join {preview.businessName}</h2>
          <p className="hint">
            You’ve been invited to join <strong>{preview.businessName}</strong> as{' '}
            <span data-testid="invite-role">{ROLE_NAMES[preview.role]}</span>.
          </p>
          <FormError message={error} />
          <button type="button" disabled={busy} onClick={() => void join(token)}>
            Join {preview.businessName}
          </button>
        </section>
      );
    }
  }
}
