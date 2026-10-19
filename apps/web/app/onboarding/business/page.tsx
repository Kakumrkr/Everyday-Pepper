import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { CreateBusinessForm } from '../../_components/create-business-form';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your business · Pepper' };

/** Phase 9 turns this into zero-setup onboarding; for now it asks the essentials. */
export default async function CreateBusinessPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  return (
    <main>
      <h1>Tell us about your business</h1>
      <p className="tagline">You can change these later.</p>
      <CreateBusinessForm />
    </main>
  );
}
