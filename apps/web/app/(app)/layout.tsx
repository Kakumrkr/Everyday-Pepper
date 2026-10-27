import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { requiredStep } from '../../lib/account';
import { appNav } from '../../lib/nav';
import { MANIFEST_URL } from '../../lib/pwa';
import { AppNav } from '../_components/app-nav';
import { ServiceWorker } from '../_components/service-worker';
import { Unavailable } from '../_components/unavailable';
import { currentAccount, currentBusiness } from '../_server/account';

// Per request: the shell depends on the session cookie.
export const dynamic = 'force-dynamic';

// Installable from the signed-in app only (ADR-0023): the public booking page is a business's
// page for its clients, so it neither links the manifest nor registers the worker.
export const metadata: Metadata = {
  manifest: MANIFEST_URL,
  appleWebApp: { capable: true, title: 'Pepper', statusBarStyle: 'default' },
  // Setting icons here replaces the root's app/icon.svg, so the favicon is listed again.
  icons: {
    icon: { url: '/icon.svg', type: 'image/svg+xml' },
    apple: '/icons/apple-touch-icon.png',
  },
};

/**
 * The signed-in app's shell (S14, S41): bottom tabs on phones, a sidebar from 960 px. Sends people
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
        nav={appNav(current?.permissions ?? null)}
        businessName={current?.business.name ?? null}
      />
      <main className="min-w-0 px-5 pt-6 pb-28 desk:px-10 desk:pt-10 desk:pb-10">{children}</main>
      <ServiceWorker />
    </div>
  );
}
