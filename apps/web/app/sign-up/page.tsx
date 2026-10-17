import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../lib/account';
import { safeNext } from '../../lib/invite';
import { SignUpForm } from '../_components/sign-up-form';
import { currentAccount } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Create your account · Floty' };

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams)['next']);
  if ((await currentAccount()).state === 'signed-in') redirect(next ?? ROUTES.home);
  return (
    <main>
      <h1 className="wordmark">floty</h1>
      <p className="tagline">Hire your AI employee. Start with your account.</p>
      <SignUpForm next={next} />
    </main>
  );
}
