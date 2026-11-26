import { buttonStyle, cx, FOCUS_RING } from '@pepper/ui';
import Link from 'next/link';
import type { CalendarView } from '../../../lib/calendar';

// The calendar's links on the kit (S42, S69): the day and week buttons as pills (the arrows
// square, 44 px, D3), and the staff filter and view switch as segmented tracks of links, so
// each view has a URL (DESIGN.md §2).
export const DAY_LINK = buttonStyle({ variant: 'secondary', size: 'sm' });
export const ARROW_LINK = cx(DAY_LINK, 'w-11 px-0');
export const SEGMENT = cx(
  'inline-flex min-h-11 shrink-0 items-center rounded-pill px-4 type-label whitespace-nowrap no-underline',
  'text-ink-2 transition motion-base ease-standard hover:text-ink',
  'aria-[current=true]:bg-surface aria-[current=true]:text-ink aria-[current=true]:shadow-raised',
  FOCUS_RING,
);

/**
 * Day · Week (AC-X-144) · My week (S72.2, AC-X-189, only with its link: a member linked to a staff
 * member): links in a segmented track, the current one raised.
 */
export function ViewSwitch({
  view,
  hrefs,
}: {
  view: CalendarView;
  hrefs: { day: string; week: string; 'my-week'?: string | null | undefined };
}) {
  const links: [CalendarView, string, string | null | undefined][] = [
    ['day', 'Day', hrefs.day],
    ['week', 'Week', hrefs.week],
    ['my-week', 'My week', hrefs['my-week']],
  ];
  return (
    <nav aria-label="View" className="inline-flex gap-1 rounded-pill bg-surface-2 p-1">
      {links.map(([one, label, href]) =>
        href === null || href === undefined ? null : (
          <Link
            key={one}
            href={href}
            aria-current={view === one ? 'true' : undefined}
            className={SEGMENT}
          >
            {label}
          </Link>
        ),
      )}
    </nav>
  );
}
