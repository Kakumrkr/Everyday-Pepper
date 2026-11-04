import { BUSINESS_EXPORT_FILES, DeletionStatusSchema } from '@pepper/contracts';
import { List, ListRow } from '@pepper/ui';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { BUSINESS_DELETION_PATH, deletionDayLabel } from '../../../../lib/deletion';
import { ExportDownload } from '../../../_components/export-download';
import { kitLink } from '../../../_components/kit-link';
import { currentAccount, currentBusiness, currentJson } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your data · Pepper' };

/**
 * Your data (S51, ADR-0053, AC-W1-37): the owner downloads everything the business keeps in
 * Pepper as one ZIP. Owners only (`business.export`; the api decides again); anyone else is
 * sent back to More, which doesn't offer it to them.
 */
export default async function YourDataPage() {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (current?.permissions.includes('business.export') !== true) redirect(ROUTES.more);
  const deletion = current.permissions.includes('business.delete')
    ? await currentJson(BUSINESS_DELETION_PATH, DeletionStatusSchema)
    : null;
  const dueAt = deletion?.dueAt ?? null;

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-8 pb-24 desk:pb-0">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 type-display">Your data</h1>
        <p className="m-0 type-body text-ink-2">
          Everything {current.business.name} keeps in Pepper, in one file. Open it in any
          spreadsheet, take it to another app, or keep a copy.
        </p>
      </div>
      <section aria-labelledby="export-files" className="flex flex-col gap-1">
        <h2 id="export-files" className="m-0 type-heading">
          What’s in it
        </h2>
        <List>
          {BUSINESS_EXPORT_FILES.map((file) => (
            <ListRow key={file.name} title={file.name} meta={file.holds} />
          ))}
        </List>
      </section>
      <section aria-labelledby="export-notes" className="flex flex-col gap-1">
        <h2 id="export-notes" className="m-0 type-heading">
          Good to know
        </h2>
        <List>
          <ListRow
            title="Bring it back any time"
            meta="Clients → Import takes clients.csv, then visits.csv, with nothing to match up."
          />
          <ListRow
            title="Made when you ask"
            meta="Pepper builds the file for you and keeps no copy of it."
          />
          <ListRow
            title="Only you can download it"
            meta="It has your clients’ names, emails and phone numbers, so it’s for the owner only."
          />
        </List>
      </section>
      {deletion === null ? null : (
        <section aria-labelledby="export-leave" className="flex flex-col gap-1">
          <h2 id="export-leave" className="m-0 type-heading">
            Leaving Pepper
          </h2>
          <List>
            <ListRow
              title={dueAt === null ? `Delete ${current.business.name}` : 'Being deleted'}
              meta={
                dueAt === null
                  ? 'Pepper keeps it for 30 days, then deletes everything. Download your data first.'
                  : `On ${deletionDayLabel(dueAt, current.business.timeZone)}. Keep it until then.`
              }
              href={ROUTES.deleteBusiness}
              renderLink={kitLink}
            />
          </List>
        </section>
      )}
      <ExportDownload />
    </div>
  );
}
