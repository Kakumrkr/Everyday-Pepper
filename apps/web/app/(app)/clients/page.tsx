import { ClientsResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { ClientsScreen } from '../../_components/clients/clients-screen';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Clients · Pepper' };

/**
 * The business's clients (S16). Owners and managers see and add everyone; staff see the
 * clients they have appointments with (AC-W9-1, decided by the api). On the kit since S42.
 */
export default async function ClientsPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.read')) redirect(ROUTES.home);

  const answer = await currentJson('/v1/clients?limit=50', ClientsResponseSchema);
  const manages = current.permissions.includes('clients.manage');

  return <ClientsScreen initial={answer?.clients ?? null} manages={manages} />;
}
