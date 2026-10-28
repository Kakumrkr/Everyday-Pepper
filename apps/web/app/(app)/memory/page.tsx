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
 * conversations, and the pause switch. Read fresh on every visit, never cached. On the kit
 * since S42.3 (AC-X-10).
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
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 type-display">What I know</h1>
        <p className="m-0 type-body text-ink-2">
          Everything I remember{current === null ? '' : ` about ${current.business.name}`}. Fix
          anything that’s wrong. When you delete something, I forget it everywhere, chats included,
          and it can’t be undone.
        </p>
      </header>
      {current === null || facts === null || episodes === null || settings === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
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
