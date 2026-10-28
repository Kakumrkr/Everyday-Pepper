import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { TwoFactorSetup } from '../../_components/two-factor-setup';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Two-step verification · Pepper' };

export default async function TwoFactorPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  if (account.me.user.twoFactorEnabled) redirect(ROUTES.home);
  return <TwoFactorSetup />;
}
