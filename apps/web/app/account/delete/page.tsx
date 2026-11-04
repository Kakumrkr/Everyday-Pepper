import { DeletionStatusSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { ACCOUNT_DELETION_PATH, deletionDayLabel } from '../../../lib/deletion';
import { AccountDeletion } from '../../_components/deletion/account-deletion';
import { Unavailable } from '../../_components/unavailable';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Delete your account · Pepper' };

/**
 * Delete account (S51.2, ADR-0054, AC-W1-42), from More → Account: anyone signed in, with or
 * without a business (an account screen, like changing the email). The day is said in the
 * current business's time zone, or UTC without one.
 */
export default async function DeleteAccountPage() {
  const account = await currentAccount();
  if (account.state === 'signed-out') redirect(ROUTES.signIn);
  if (account.state === 'unavailable') return <Unavailable />;
  const current = account.me.activeTenantId === null ? null : await currentBusiness();
  const status = await currentJson(ACCOUNT_DELETION_PATH, DeletionStatusSchema);
  if (status === null) return <Unavailable />;
  const dueAt = status.dueAt;
  const timeZone = current?.business.timeZone ?? 'UTC';
  return (
    <AccountDeletion
      email={account.me.user.email}
      dueLabel={dueAt === null ? null : deletionDayLabel(dueAt, timeZone)}
      canDeleteBusiness={current?.permissions.includes('business.delete') === true}
    />
  );
}
