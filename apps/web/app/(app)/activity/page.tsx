import { AiActionsResponseSchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { ACTIVITY_PAGE, ActivityScreen } from '../../_components/activity/activity-screen';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Activity · Pepper' };

/**
 * Activity (S52, ADR-0043, AC-W7-4): everything Pepper did that the member may see, newest
 * first, in plain words, with Undo while it is open. Staff see what was done for them. Read
 * fresh on every visit.
 */
export default async function ActivityPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const page =
    current === null
      ? null
      : await currentJson(`/v1/ai/actions?limit=${String(ACTIVITY_PAGE)}`, AiActionsResponseSchema);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">Activity</h1>
        <p className="m-0 type-body text-ink-2">
          Everything I’ve done{current === null ? '' : ` for ${current.business.name}`}, newest
          first: what changed, who approved it and what was sent.
        </p>
      </header>
      {current === null || page === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read what I’ve done right now. Try again in a moment.
        </p>
      ) : (
        <ActivityScreen initial={page} timeZone={current.business.timeZone} />
      )}
    </div>
  );
}
