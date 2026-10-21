import { BusinessAutonomySchema } from '@pepper/contracts';
import type { Metadata } from 'next';
import { AutonomySettings } from '../../_components/autonomy/autonomy-settings';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Autonomy · Pepper' };

/**
 * What Pepper may do on its own (S26, ADR-0028/0031), grouped by risk. Everyone in the business
 * reads it; owners and managers change it; the AI never does.
 */
export default async function AutonomyPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const autonomy =
    current === null ? null : await currentJson('/v1/autonomy', BusinessAutonomySchema);
  if (current === null || autonomy === null) {
    return (
      <p className="mx-auto max-w-3xl">The settings can’t be read right now. Try again soon.</p>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <p className="m-0 text-xs font-bold tracking-wide text-ink-2 uppercase">Trust</p>
        <h1 className="m-0 font-display text-2xl font-bold">Autonomy</h1>
      </div>
      <p className="m-0 text-ink-2">
        Choose what I do on my own. Start careful and give me more room as you get comfortable. I
        can suggest changes, but only you can make them here, and every change is logged.
      </p>
      <AutonomySettings
        initial={autonomy}
        canChange={current.permissions.includes('autonomy.manage')}
      />
    </div>
  );
}
