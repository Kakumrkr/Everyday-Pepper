import { buttonStyle } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../lib/account';
import { safeNext } from '../../lib/invite';
import { AuthPage } from '../_components/auth-page';
import { currentAccount } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your email · Pepper' };

/**
 * Where an emailed check link lands once opened (S44): a new account's goes on to `next` or
 * home (signed in by the link); a change of email's first link (from the current address,
 * `changed=pending`) says one more link is on its way, its second (`changed=1`) that it's done;
 * a link that didn't work says how to start again.
 */
export default async function EmailConfirmedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const change = params['changed'];
  if (params['error'] !== undefined && change !== undefined) {
    return (
      <AuthPage
        title="This link didn’t work"
        lead="Links to change your email work for 24 hours, and only for the account that asked. Start the change again."
        action={
          <Link href={ROUTES.changeEmail} className={buttonStyle({ size: 'lg', block: true })}>
            Change email again
          </Link>
        }
      />
    );
  }
  if (params['error'] !== undefined) {
    return (
      <AuthPage
        title="This link has run out"
        lead="Links to confirm an email work for 24 hours. Sign in and we’ll send you a new one."
        action={
          <Link href={ROUTES.signIn} className={buttonStyle({ size: 'lg', block: true })}>
            Sign in
          </Link>
        }
      />
    );
  }
  if (change === 'pending') {
    const signedIn = (await currentAccount()).state === 'signed-in';
    return (
      <AuthPage
        title="One more step"
        lead="We sent a link to your new email. Open it to finish the change. Until then, you sign in with your current email."
        action={
          <Link
            href={signedIn ? ROUTES.more : ROUTES.signIn}
            className={buttonStyle({ size: 'lg', block: true })}
          >
            {signedIn ? 'Done' : 'Sign in'}
          </Link>
        }
      />
    );
  }
  if (change === '1') {
    const account = await currentAccount();
    const email = account.state === 'signed-in' ? account.me.user.email : null;
    return (
      <AuthPage
        title="Your email is changed"
        lead={
          email === null ? (
            'Sign in with your new email from now on.'
          ) : (
            <>
              You sign in with <span className="font-semibold break-all text-ink">{email}</span>{' '}
              from now on.
            </>
          )
        }
        action={
          <Link
            href={email === null ? ROUTES.signIn : ROUTES.more}
            className={buttonStyle({ size: 'lg', block: true })}
          >
            {email === null ? 'Sign in' : 'Done'}
          </Link>
        }
      />
    );
  }
  redirect(safeNext(params['next']) ?? ROUTES.home);
}
