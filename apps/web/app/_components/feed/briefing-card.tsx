'use client';

import type { FeedResponse } from '@pepper/contracts';
import { DailyBriefing } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { sendJson } from '../../../lib/client-api';
import { saveFeedSettings } from '../../../lib/feed-settings';

/**
 * Home's daily briefing (S38a, ADR-0042) on `/v1/feed`: "Got it" closes it as done until
 * tomorrow's; owners and managers set the morning hour, which refreshes the page.
 */
export function BriefingCard({ feed, timeZone }: { feed: FeedResponse; timeZone: string }) {
  const router = useRouter();
  return (
    <DailyBriefing
      briefing={feed.briefing}
      timeZone={timeZone}
      canChangeSettings={feed.canChangeSettings}
      morningHour={feed.settings.morningHour}
      templateMorningHour={feed.templateMorningHour}
      onRead={async (id) => {
        const answer = await sendJson('POST', `/v1/feed/${id}/close`, { outcome: 'done' });
        return answer.ok ? null : answer.message;
      }}
      onHour={(morningHour) =>
        saveFeedSettings({ morningHour }, () => {
          router.refresh();
        })
      }
    />
  );
}
