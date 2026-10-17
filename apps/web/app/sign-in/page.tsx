import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../lib/account';
import { safeNext } from '../../lib/invite';
import { ApiStatus } from '../_components/api-status';
import { SignInForm } from '../_components/sign-in-form';
import { currentAccount } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Sign in · Floty' };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams)['next']);
  if ((await currentAccount()).state === 'signed-in') redirect(next ?? ROUTES.home);
  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <p className="tagline">Sign in to your business.</p>
      <SignInForm next={next} />
      <ApiStatus />
    </main>
  );
}
