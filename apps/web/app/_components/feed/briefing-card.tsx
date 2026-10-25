'use client';

import { FeedSettingsSchema, type FeedResponse } from '@pepper/contracts';
import { DailyBriefing } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { sendJson } from '../../../lib/client-api';

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
      onHour={async (morningHour) => {
        const answer = await sendJson('PATCH', '/v1/feed/settings', { morningHour });
        if (!answer.ok) return answer.message;
        if (!FeedSettingsSchema.safeParse(answer.data).success) return 'Something went wrong.';
        router.refresh();
        return null;
      }}
    />
  );
}
