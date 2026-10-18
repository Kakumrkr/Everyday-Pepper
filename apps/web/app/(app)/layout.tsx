import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { requiredStep } from '../../lib/account';
import { navItems } from '../../lib/nav';
import { AppNav } from '../_components/app-nav';
import { Unavailable } from '../_components/unavailable';
import { currentAccount, currentBusiness } from '../_server/account';

// Per request: the shell depends on the session cookie.
export const dynamic = 'force-dynamic';

/**
 * The signed-in app's shell (S14): bottom tabs on phones, a sidebar from 960 px. Sends people
 * who still have a step to do (sign in, create a business, two-step) there first.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const account = await currentAccount();
  const step = requiredStep(account);
  if (step !== null) redirect(step);
  if (account.state !== 'signed-in') return <Unavailable />;
  const current = await currentBusiness();

  return (
    <div className="min-h-dvh desk:grid desk:grid-cols-[240px_minmax(0,1fr)]">
      <AppNav
        items={navItems(current?.permissions ?? null)}
        businessName={current?.business.name ?? null}
      />
      <main className="min-w-0 px-4 pt-6 pb-28 desk:px-10 desk:pt-10 desk:pb-10">{children}</main>
    </div>
  );
}
