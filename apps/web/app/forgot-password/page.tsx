import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../lib/account';
import { ForgotPasswordForm } from '../_components/password-reset';
import { currentAccount } from '../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Forgot your password? · Pepper' };

export default async function ForgotPasswordPage() {
  if ((await currentAccount()).state === 'signed-in') redirect(ROUTES.home);
  return <ForgotPasswordForm />;
}
