import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { ChangeEmailForm } from '../../_components/change-email-form';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Change your email · Pepper' };

export default async function ChangeEmailPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  return <ChangeEmailForm current={account.me.user.email} />;
}
