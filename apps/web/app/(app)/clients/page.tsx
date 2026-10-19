import { ClientsResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { ClientDirectory } from '../../_components/clients/client-directory';
import { ClientEditor } from '../../_components/clients/client-editor';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Clients · Pepper' };

/**
 * The business's clients (S16). Owners and managers see and add everyone; staff see the
 * clients they have appointments with (AC-W9-1, decided by the api).
 */
export default async function ClientsPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('clients.read')) redirect(ROUTES.home);

  const answer = await currentJson('/v1/clients?limit=50', ClientsResponseSchema);
  const manages = current.permissions.includes('clients.manage');

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold">Clients</h1>
          <p className="m-0 text-ink-2">
            {manages ? 'Everyone who books with you.' : 'The clients you have appointments with.'}
          </p>
        </div>
        {manages ? <ClientEditor /> : null}
      </header>
      {answer === null ? (
        <p role="alert" className="rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load your clients. Try again in a moment.
        </p>
      ) : (
        <ClientDirectory initial={answer.clients} staffView={!manages} />
      )}
    </div>
  );
}
