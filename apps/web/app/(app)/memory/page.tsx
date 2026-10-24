import {
  MemoryEpisodesResponseSchema,
  MemoryFactsResponseSchema,
  MemorySettingsSchema,
} from '@pepper/contracts';
import type { Metadata } from 'next';
import { MemoryScreen } from '../../_components/memory/memory-screen';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'What I know · Pepper' };

/**
 * "What I know" (S32, playbook §7): what Pepper remembers that the member may read (staff:
 * their clients and visits, and the business's non-sensitive facts), their own past
 * conversations, and the pause switch. Read fresh on every visit, never cached.
 */
export default async function MemoryPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const [facts, episodes, settings] = await Promise.all([
    currentJson('/v1/memory/facts', MemoryFactsResponseSchema),
    currentJson('/v1/memory/episodes', MemoryEpisodesResponseSchema),
    currentJson('/v1/memory/settings', MemorySettingsSchema),
  ]);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div>
        <p className="m-0 text-xs font-bold tracking-wide text-ink-2 uppercase">Trust</p>
        <h1 className="m-0 font-display text-2xl font-bold">What I know</h1>
      </div>
      <p className="m-0 text-ink-2">
        Everything I remember{current === null ? '' : ` about ${current.business.name}`}. Fix
        anything that’s wrong. When you delete something, I forget it everywhere, chats included,
        and it can’t be undone.
      </p>
      {current === null || facts === null || episodes === null || settings === null ? (
        <p role="alert" className="rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t read what I know right now. Try again in a moment.
        </p>
      ) : (
        <MemoryScreen
          initialFacts={facts.facts}
          initialEpisodes={episodes.episodes}
          paused={settings.paused}
          permissions={current.permissions}
          timeZone={current.business.timeZone}
        />
      )}
    </div>
  );
}
