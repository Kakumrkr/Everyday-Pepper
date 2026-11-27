'use client';

import {
  parseDate,
  type FeedItem,
  type FeedResponse,
  type FeedSettingsChange,
} from '@pepper/contracts';
import { buttonStyle, cx, FeedSuggestions, type FeedAction } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ROUTES } from '../../../lib/account';
import { calendarHref } from '../../../lib/calendar';
import { sendJson } from '../../../lib/client-api';
import { saveFeedSettings } from '../../../lib/feed-settings';
import { MORE_HREF } from '../../../lib/nav';
import { kitLink } from '../kit-link';

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
    case 'waitlist_match':
      return { label: 'Open the waitlist', href: ROUTES.waitlist };
    // S71.2: the booking's day, where it can be moved or cancelled.
    case 'calendar_kept':
      return { label: 'Open the calendar', href: day(item.day) };
    // Shown on its own card (`BriefingCard`), never as a suggestion; S80's texts on their own
    // cards (`ClientTextCards`), with Reply.
    case 'daily_briefing':
    case 'client_text':
      return null;
  }
}

/**
 * Home's "Suggestions" (S35, ADR-0039) on `/v1/feed`, as the card board (S52, ADR-0043):
 * ranked by dollars and grouped, quiet before the first visit; dismiss and acting on a suggestion close
 * it; the switches refresh the page so the server reads the feed again. The mailing address
 * rebooking emails carry moved to More's settings (S41, `MailingAddressSetting`); until it is
 * set, a line here leads there.
 */
export function FeedCard({ feed, timeZone }: { feed: FeedResponse; timeZone: string }) {
  const router = useRouter();
  const changeSettings = (change: FeedSettingsChange) =>
    saveFeedSettings(change, () => {
      router.refresh();
    });
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
        <Link href={action.href} onClick={onFollow} className={buttonStyle({ size: 'sm' })}>
          {action.label}
        </Link>
      )}
      onClose={async (id, outcome) => {
        const answer = await sendJson('POST', `/v1/feed/${id}/close`, { outcome });
        return answer.ok ? null : answer.message;
      }}
      onCloseMany={async (ids, outcome) => {
        const answer = await sendJson('POST', '/v1/feed/close', { ids, outcome });
        return answer.ok ? null : answer.message;
      }}
      onSettings={changeSettings}
      renderLink={kitLink}
      // The board's quiet start (S52, AC-W4-5): nothing to suggest before the first visit.
      quiet={!feed.hasBookingHistory}
      quietAction={
        <Link
          href={ROUTES.calendar}
          className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4')}
        >
          Add a booking
        </Link>
      }
      footer={
        // Until the address is set no rebooking email is drafted (ADR-0040), so Home says so.
        feed.canChangeSettings && feed.mailingAddress === null ? (
          <div className="flex flex-wrap items-center gap-x-2" data-testid="mailing-address-needed">
            <p className="m-0 type-body text-ink-2">
              I can draft rebooking emails for regulars who are due once your mailing address is
              set.
            </p>
            <Link
              href={MORE_HREF}
              className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4')}
            >
              Add your address
            </Link>
          </div>
        ) : null
      }
    />
  );
}
