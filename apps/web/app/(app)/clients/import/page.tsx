import { ImportBatchIdSchema, ImportPreviewSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { ImportScreen } from '../../../_components/clients/import-screen';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Bring your clients · Pepper' };

/**
 * Client import (S48.2, ADR-0049, AC-W1-17…21): owners and managers (`clients.manage`; the api
 * decides again) bring their client list from another app. `?batch=` opens an import where it
 * is: a staged one at its preview, one that started at its result.
 */
export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.manage')) redirect(ROUTES.clients);

  const { batch } = await searchParams;
  const id = ImportBatchIdSchema.safeParse(batch);
  const initial = id.success
    ? await currentJson(`/v1/imports/${id.data}`, ImportPreviewSchema)
    : null;

  return (
    <ImportScreen
      initial={initial}
      missing={batch !== undefined && initial === null}
      timeZone={current.business.timeZone}
    />
  );
}
