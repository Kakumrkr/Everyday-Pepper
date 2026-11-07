import { OperatorMeSchema } from '@pepper/contracts';
import { cx, FOCUS_RING, Logo } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { ROUTES } from '../../lib/account';
import { OPS_PATHS } from '../../lib/ops';
import { currentAccount, currentJson } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Support console · Pepper',
  robots: { index: false, follow: false },
};

/**
 * Pepper's support console (S59.2, ADR-0062, AC-X-19): for the team's operators only. Signed
 * out goes to sign-in; any other account (an owner included) finds nothing here. The api
 * checks the grant again on every call.
 */
export default async function OpsLayout({ children }: { children: ReactNode }) {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  const me =
    account.state === 'signed-in' ? await currentJson('/v1/ops/me', OperatorMeSchema) : null;
  if (me === null) notFound();
  return (
    <div className="min-h-dvh bg-bg">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-4 pt-5 sm:px-6">
        <Link
          href={OPS_PATHS.inbox}
          className={cx('inline-flex min-h-11 items-center gap-3 no-underline', FOCUS_RING)}
        >
          <Logo />
          <span className="type-label text-ink-2">Support</span>
        </Link>
        <span className="truncate type-caption text-ink-2">{me.name}</span>
      </header>
      <main className="mx-auto flex w-full min-w-0 max-w-3xl flex-col gap-6 px-4 pt-6 pb-16 sm:px-6">
        {children}
      </main>
    </div>
  );
}
