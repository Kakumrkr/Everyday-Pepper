import { ClientsPageSchema, ImportBatchIdSchema, WinBackResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { clientsPath } from '../../../lib/clients';
import { ClientsScreen } from '../../_components/clients/clients-screen';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Clients · Pepper' };

/**
 * The business's clients (S16). Owners and managers see and add everyone; staff see the
 * clients they have appointments with (AC-W9-1, decided by the api). On the kit since S42.
 * `?import=` (owners and managers, S49.2, AC-W1-29): only the clients that import added.
 * Owners and managers also get the way to "Haven't been back" with its count (S54.2).
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
  const answer = await currentJson(clientsPath({ importId }), ClientsPageSchema);
  // "Haven't been back" (S54.2): owners and managers, on the whole list only.
  const leads = current.role === 'owner' || current.role === 'manager';
  const winBack =
    leads && importId === null ? await currentJson('/v1/win-back', WinBackResponseSchema) : null;

  return (
    // Keyed by the filter: "Show everyone" is the same screen, so its list starts again.
    <ClientsScreen
      key={importId ?? 'everyone'}
      initial={answer}
      manages={manages}
      importId={importId}
      winBack={winBack === null ? null : { count: winBack.count, totalCents: winBack.totalCents }}
    />
  );
}
