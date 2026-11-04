import {
  AutonomyTrackRecordSchema,
  AutonomyViewSchema,
  BookingRulesResponseSchema,
} from '@pepper/contracts';
import { localDay } from '@pepper/ui';
import type { Metadata } from 'next';
import { AutonomySettings } from '../../_components/autonomy/autonomy-settings';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Autonomy · Pepper' };

/**
 * What Pepper may do on its own (S26, ADR-0028/0031), grouped by risk. Everyone in the business
 * reads it; owners and managers change it; the AI never does. On the kit since S42.3 (AC-X-10).
 * S53 (ADR-0055): presets, the standing rules in words, each action's 30-day count and the
 * earned-trust offers.
 */
export default async function AutonomyPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const [autonomy, trackRecord, rules] =
    current === null
      ? [null, null, null]
      : await Promise.all([
          currentJson('/v1/autonomy', AutonomyViewSchema),
          // Counts and rules are extras: the dial still shows without them.
          currentJson('/v1/autonomy/track-record', AutonomyTrackRecordSchema),
          current.permissions.includes('rules.read')
            ? currentJson('/v1/rules', BookingRulesResponseSchema)
            : Promise.resolve(null),
        ]);
  if (current === null || autonomy === null) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        <AutonomyHeader />
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load these settings. Try again in a moment.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <AutonomyHeader />
      <AutonomySettings
        initial={autonomy}
        canChange={current.permissions.includes('autonomy.manage')}
        trackRecord={trackRecord}
        rules={rules}
        today={localDay(new Date().toISOString(), current.business.timeZone)}
      />
    </div>
  );
}

function AutonomyHeader() {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="m-0 type-display">Autonomy</h1>
      <p className="m-0 type-body text-ink-2">
        Choose what I do on my own. Start careful and give me more room as you get comfortable. I
        can suggest changes, but only you can make them here, and every change is logged.
      </p>
    </header>
  );
}
