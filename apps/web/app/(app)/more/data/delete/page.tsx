import { DeletionStatusSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../../lib/account';
import { BUSINESS_DELETION_PATH, deletionDayLabel } from '../../../../../lib/deletion';
import { BusinessDeletion } from '../../../../_components/deletion/business-deletion';
import { currentAccount, currentBusiness, currentJson } from '../../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Delete business · Pepper' };

/**
 * Delete business (S51.2, ADR-0054, AC-W1-40), from Your data: the owner only
 * (`business.delete`; the api decides again); anyone else goes back to More.
 */
export default async function DeleteBusinessPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current?.permissions.includes('business.delete') !== true) redirect(ROUTES.more);
  const status = await currentJson(BUSINESS_DELETION_PATH, DeletionStatusSchema);
  const { name, timeZone } = current.business;
  const dueAt = status?.dueAt ?? null;
  const dueLabel = dueAt === null ? null : deletionDayLabel(dueAt, timeZone);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8 pb-24 desk:pb-0">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 type-display">
          {dueLabel === null ? `Delete ${name}` : `${name} is being deleted`}
        </h1>
        {dueLabel === null ? (
          <p className="m-0 type-body text-ink-2">
            Pepper keeps {name} for 30 days, then deletes it for good. You can keep it any time
            before then.
          </p>
        ) : null}
      </div>
      <BusinessDeletion name={name} dueLabel={dueLabel} />
    </div>
  );
}
