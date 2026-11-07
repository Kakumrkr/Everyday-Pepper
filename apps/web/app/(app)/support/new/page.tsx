import type { Metadata } from 'next';
import { SupportForm } from '../../../_components/support/support-form';
import { currentAccount, currentBusiness } from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Tell us what went wrong · Pepper' };

type Query = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (typeof value === 'string' ? value : null);

/**
 * "Tell us what went wrong" (S59, PCR-010, AC-X-14), from More, a help article (`?topic=`) or
 * an error state (`?error=`), with the page it came from (`?from=`). The form checks each
 * value's shape before it goes anywhere.
 */
export default async function NewSupportRequestPage({
  searchParams,
}: {
  searchParams: Promise<Query>;
}) {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const query = await searchParams;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Tell us what went wrong</h1>
        <p className="m-0 type-body text-ink-2">
          A person on the Pepper team reads every request and answers the same day.
        </p>
      </header>
      {current === null ? (
        <p className="m-0 rounded-lg bg-surface-2 px-5 py-4 type-body text-ink-2">
          Choose a business on More first, so we know which one you mean.
        </p>
      ) : (
        <SupportForm
          query={{
            from: one(query['from']),
            topic: one(query['topic']),
            error: one(query['error']),
          }}
          email={account.me.user.email}
          seesAll={current.role !== 'staff'}
        />
      )}
    </div>
  );
}
