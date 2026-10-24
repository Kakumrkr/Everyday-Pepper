'use client';

import {
  FeedSettingsSchema,
  parseDate,
  type FeedItem,
  type FeedResponse,
  type FeedSettingsChange,
} from '@pepper/contracts';
import { buttonClass, FeedSuggestions, MailingAddress, type FeedAction } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { calendarHref } from '../../../lib/calendar';
import { sendJson } from '../../../lib/client-api';

/** Where a suggestion leads: the day on the calendar, or the client. */
function actionFor(item: FeedItem): FeedAction | null {
  const day = (date: string) => calendarHref(parseDate(date), item.subjects.staffMemberId);
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
 * it; the switches, and the mailing address rebooking emails carry (S36, owners and managers),
 * refresh the page so the server reads the feed again.
 */
export function FeedCard({ feed, timeZone }: { feed: FeedResponse; timeZone: string }) {
  const router = useRouter();
  const changeSettings = async (change: FeedSettingsChange): Promise<string | null> => {
    const answer = await sendJson('PATCH', '/v1/feed/settings', change);
    if (!answer.ok) return answer.message;
    if (!FeedSettingsSchema.safeParse(answer.data).success) return 'Something went wrong.';
    router.refresh();
    return null;
  };
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
      onSettings={changeSettings}
      footer={
        feed.canChangeSettings ? (
          <MailingAddress
            address={feed.mailingAddress}
            onSave={(mailingAddress) => changeSettings({ mailingAddress })}
          />
        ) : null
      }
    />
  );
}
