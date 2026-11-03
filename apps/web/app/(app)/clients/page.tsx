import { ClientsResponseSchema, ImportBatchIdSchema } from '@pepper/contracts';
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
 * `?import=` (owners and managers, S49.2, AC-W1-29): only the clients that import added.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.read')) redirect(ROUTES.home);

  const manages = current.permissions.includes('clients.manage');
  const parsed = ImportBatchIdSchema.safeParse((await searchParams)['import']);
  // Imports are owners' and managers' (staff never see one); anything else lists everyone.
  const importId = manages && parsed.success ? parsed.data : null;
  const query = new URLSearchParams({ limit: '50' });
  if (importId !== null) query.set('import', importId);
  const answer = await currentJson(`/v1/clients?${query.toString()}`, ClientsResponseSchema);

  return (
    // Keyed by the filter: "Show everyone" is the same screen, so its list starts again.
    <ClientsScreen
      key={importId ?? 'everyone'}
      initial={answer?.clients ?? null}
      manages={manages}
      importId={importId}
    />
  );
}
