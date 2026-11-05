import { WinBackResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { WinBackScreen } from '../../../_components/clients/win-back-screen';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Haven’t been back · Pepper' };

/**
 * "Haven't been back" (S54.2, ADR-0057; AC-W4-6, AC-W4-7, AC-W4-9): the clients past their
 * usual gap, each with a one-tap drafted email. Owners and managers only (the api decides
 * again); staff go to Clients.
 */
export default async function WinBackPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current === null || (current.role !== 'owner' && current.role !== 'manager')) {
    redirect(ROUTES.clients);
  }
  const answer = await currentJson('/v1/win-back', WinBackResponseSchema);
  return <WinBackScreen initial={answer} timeZone={current.business.timeZone} />;
}
