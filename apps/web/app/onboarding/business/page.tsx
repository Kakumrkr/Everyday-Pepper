import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { CreateBusinessForm } from '../../_components/create-business-form';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your business · Pepper' };

/** Phase 10 pre-fills the menu and hours from the business type (S45); for now the essentials. */
export default async function CreateBusinessPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  return <CreateBusinessForm />;
}
