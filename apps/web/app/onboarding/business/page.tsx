import { TemplatesResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { CreateBusinessForm } from '../../_components/create-business-form';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your business · Pepper' };

/** A new business: its type pre-fills the menu and hours (S45, ADR-0046). */
export default async function CreateBusinessPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  const types = await currentJson('/v1/templates', TemplatesResponseSchema);
  if (types === null) return <Unavailable />;
  return <CreateBusinessForm types={types.templates} />;
}
