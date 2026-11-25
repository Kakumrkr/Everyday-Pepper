import { buttonStyle, Card } from '@pepper/ui';
import Link from 'next/link';
import { ROUTES } from '../../../lib/account';

/**
 * Home's "Reconnect your Google Calendar" (S70.2, AC-X-163, ADR-0069 D-1): shown only to the
 * member whose own connection needs reconnecting (in testing mode Google asks every 7 days),
 * worked out from their status on each visit, so it is gone once they reconnect or disconnect.
 */
export function ReconnectCard() {
  return (
    <Card labelledBy="reconnect-heading">
      <div data-testid="calendar-reconnect-card" className="flex flex-col gap-3">
        <h2 id="reconnect-heading" className="m-0 type-heading">
          Reconnect your Google Calendar
        </h2>
        <p className="m-0 type-body text-ink-2">
          Google stopped letting me read when you’re busy. I’m keeping the busy times I have, so
          nothing gets booked over them, but new plans won’t show until you reconnect.
        </p>
        <Link
          href={ROUTES.calendarSettings}
          className={buttonStyle({ variant: 'primary', block: true })}
        >
          Reconnect
        </Link>
      </div>
    </Card>
  );
}
