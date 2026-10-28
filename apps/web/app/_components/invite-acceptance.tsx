'use client';

import type { AcceptInviteResponse, InvitePreviewResponse, InviteToken } from '@pepper/contracts';
import { Button, buttonStyle } from '@pepper/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ROUTES, withNext } from '../../lib/account';
import { sendJson } from '../../lib/client-api';
import { INVITE_TOKEN_KEY, inviteTokenFromHash } from '../../lib/invite';
import { SignOutButton } from './account-actions';
import { AuthPage, TextLink } from './auth-page';
import { Notice } from './form-parts';

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

  const mainLink = (href: string, label: string) => (
    <Link href={href} className={buttonStyle({ size: 'lg', block: true })}>
      {label}
    </Link>
  );

  switch (state.step) {
    case 'reading':
    case 'looking-up':
      return (
        <AuthPage title="Join a business" lead={<span role="status">Opening your invite…</span>} />
      );
    case 'no-token':
      return (
        <AuthPage
          title="We can’t open this invite"
          lead={
            <span role="alert">
              This invite link is incomplete. Open the link from your invite email again.
            </span>
          }
        />
      );
    case 'signed-out':
      return (
        <AuthPage
          title="You’re invited to join a business on Pepper"
          lead="Create an account or sign in with the email address the invite was sent to."
          action={mainLink(withNext(ROUTES.signUp, ROUTES.invite), 'Create an account')}
        >
          <p className="m-0 type-body text-ink-2">
            Already have an account?{' '}
            <TextLink href={withNext(ROUTES.signIn, ROUTES.invite)}>Sign in</TextLink>
          </p>
        </AuthPage>
      );
    case 'failed':
      return (
        <AuthPage
          title="This invite can’t be used"
          action={
            state.wrongAccount ? (
              <SignOutButton next={ROUTES.invite} label="Sign in with another email" main />
            ) : (
              mainLink(ROUTES.home, 'Go to Pepper')
            )
          }
        >
          <Notice tone="error">{state.message}</Notice>
          {state.wrongAccount ? (
            <p className="m-0 type-body text-ink-2">
              You’re signed in as <b className="text-ink">{email}</b>.
            </p>
          ) : null}
        </AuthPage>
      );
    case 'ready': {
      const { preview, token } = state;
      return (
        <AuthPage
          title={`Join ${preview.businessName}`}
          lead={
            <>
              You’ve been invited to join <b className="text-ink">{preview.businessName}</b> as{' '}
              <span data-testid="invite-role">{ROLE_NAMES[preview.role]}</span>.
            </>
          }
          action={
            <Button size="lg" block busy={busy} onClick={() => void join(token)}>
              Join {preview.businessName}
            </Button>
          }
        >
          {error === null ? null : <Notice tone="error">{error}</Notice>}
        </AuthPage>
      );
    }
  }
}
