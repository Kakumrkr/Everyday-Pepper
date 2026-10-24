'use client';

import {
  FeedSettingsSchema,
  type FeedItem,
  type FeedResponse,
  type FeedSettingsChange,
} from '@pepper/contracts';
import { buttonClass, FeedSuggestions, type FeedAction } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';

/** Where a suggestion leads: the day on the calendar, or the client. */
function actionFor(item: FeedItem): FeedAction | null {
  const staff = item.subjects.staffMemberId;
  const day = (date: string) =>
    `${ROUTES.calendar}?date=${date}${staff === null ? '' : `&staffMemberId=${staff}`}`;
  switch (item.kind) {
    case 'schedule_gaps':
      return { label: 'Show on calendar', href: day(item.day) };
    case 'staff_overload':
      return { label: 'Open the calendar', href: day(item.day) };
    case 'rebooking_due':
    case 'no_show_pattern':
      return item.subjects.clientId === null || item.names.client === null
        ? null
        : {
            label: `Open ${item.names.client}`,
            href: `${ROUTES.clients}/${item.subjects.clientId}`,
          };
  }
}

/**
 * Home's "Suggestions" (S35, ADR-0039) on `/v1/feed`: dismiss and acting on a suggestion close
 * it; the switches refresh the page so the server reads the feed again.
 */
export function FeedCard({ feed, timeZone }: { feed: FeedResponse; timeZone: string }) {
  const router = useRouter();
  return (
    <FeedSuggestions
      items={feed.suggestions}
      settings={feed.settings}
      canChangeSettings={feed.canChangeSettings}
      askToTurnOff={feed.askToTurnOff}
      timeZone={timeZone}
      now={Date.now()}
      actionFor={actionFor}
      renderAction={(action, onFollow) => (
        <Link
          href={action.href}
          onClick={onFollow}
          className={buttonClass({ size: 'sm', className: 'no-underline' })}
        >
          {action.label}
        </Link>
      )}
      onClose={async (id, outcome) => {
        const answer = await sendJson('POST', `/v1/feed/${id}/close`, { outcome });
        return answer.ok ? null : answer.message;
      }}
      onSettings={async (change: FeedSettingsChange) => {
        const answer = await sendJson('PATCH', '/v1/feed/settings', change);
        if (!answer.ok) return answer.message;
        if (!FeedSettingsSchema.safeParse(answer.data).success) return 'Something went wrong.';
        router.refresh();
        return null;
      }}
    />
  );
}
