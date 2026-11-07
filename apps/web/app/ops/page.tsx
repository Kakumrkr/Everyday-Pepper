import { OperatorInboxSchema, type OperatorInboxView } from '@pepper/contracts';
import { Badge, cx, EmptyState, FOCUS_RING, Icon, List, ListRow } from '@pepper/ui';
import Link from 'next/link';
import { SUPPORT_KIND_LABEL } from '../../lib/support';
import { screenshotCountLabel } from '../../lib/support-screenshots';
import {
  OPS_PATHS,
  OPS_PUBLIC_STATUS,
  OPS_RATING,
  OPS_THREAD_STATUS,
  OPS_VIEWS,
  opsView,
  overdueNote,
  waitingWords,
} from '../../lib/ops';
import { kitLink } from '../_components/kit-link';
import { currentJson } from '../_server/account';

export const dynamic = 'force-dynamic';

const EMPTY: Readonly<Record<OperatorInboxView, { title: string; body: string }>> = {
  waiting: { title: 'Nobody is waiting', body: 'Every request has an answer. New ones land here.' },
  answered: {
    title: 'Nothing answered and open',
    body: 'Requests we replied to wait here for theirs.',
  },
  solved: { title: 'Nothing solved yet', body: 'Solved requests stay here.' },
};

/**
 * The inbox (S59.2, AC-X-20): every request waiting on the team, from every business and the
 * public form, the one that has waited longest first, with how long in words; past the same-day
 * promise it says so in words too ("Over 4 h: answer next", S59.2.2). Solved requests show the
 * requester's "Did this help?" (AC-X-26).
 */
export default async function OpsInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const view = opsView((await searchParams).view);
  const inbox = await currentJson(`/v1/ops/inbox?view=${view}`, OperatorInboxSchema);
  const now = Date.now();
  return (
    <>
      <header className="flex flex-col gap-3">
        <h1 className="m-0 type-display">Inbox</h1>
        <nav aria-label="Requests">
          <ul className="m-0 flex list-none gap-1 overflow-x-auto rounded-pill bg-surface-2 p-1">
            {OPS_VIEWS.map((option) => {
              const current = option.value === view;
              return (
                <li key={option.value} className="flex-1">
                  <Link
                    href={OPS_PATHS.view(option.value)}
                    aria-current={current ? 'page' : undefined}
                    className={cx(
                      'flex min-h-11 items-center justify-center rounded-pill px-4 type-label whitespace-nowrap no-underline',
                      current ? 'bg-surface text-ink shadow-raised' : 'text-ink-2 hover:text-ink',
                      FOCUS_RING,
                    )}
                  >
                    {option.label}
                    {option.value === 'waiting' && inbox !== null && inbox.waiting > 0 ? (
                      <span className="ml-2 tabular-nums" data-testid="ops-waiting-count">
                        {inbox.waiting}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      {inbox === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read the inbox right now. Try again in a moment.
        </p>
      ) : inbox.items.length === 0 ? (
        <EmptyState
          icon="help"
          title={EMPTY[view].title}
          body={EMPTY[view].body}
          action={{
            label: view === 'waiting' ? 'See what we answered' : 'Back to waiting',
            href: OPS_PATHS.view(view === 'waiting' ? 'answered' : 'waiting'),
            renderLink: kitLink,
          }}
        />
      ) : (
        <List>
          {inbox.items.map((item) => {
            const status =
              item.source === 'thread'
                ? OPS_THREAD_STATUS[item.status]
                : OPS_PUBLIC_STATUS[item.status];
            const note = overdueNote(view, item.waitingSince, now);
            const late = note !== null;
            const rating = item.source === 'thread' && item.rating !== null ? item.rating : null;
            // S59.2.3's top-up: the team knows there is something to look at before opening it.
            const shots =
              item.source === 'thread' ? screenshotCountLabel(item.screenshotCount) : null;
            return (
              <ListRow
                key={item.id}
                href={
                  item.source === 'thread' ? OPS_PATHS.thread(item.id) : OPS_PATHS.request(item.id)
                }
                renderLink={kitLink}
                title={<span className="truncate">{item.preview}</span>}
                meta={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span
                      className={cx('tabular-nums font-semibold', late ? 'text-warn' : 'text-ink')}
                      data-testid="ops-waited"
                    >
                      {waitingWords(view, item.waitingSince, now)}
                    </span>
                    {note === null ? null : (
                      <Badge tone="warn" className="font-semibold">
                        <span data-testid="ops-overdue">{note}</span>
                      </Badge>
                    )}
                    <span>· {item.source === 'thread' ? item.business : 'Signed-out'}</span>
                    <span className="tabular-nums">· {item.reference}</span>
                    {item.source === 'thread' ? (
                      <span>· {SUPPORT_KIND_LABEL[item.kind]}</span>
                    ) : null}
                    {shots === null ? null : (
                      <Badge tone="info">
                        <span data-testid="ops-screenshots">{shots}</span>
                      </Badge>
                    )}
                    {view === 'waiting' ? null : <Badge tone={status.tone}>{status.label}</Badge>}
                    {rating === null ? null : (
                      <Badge tone={OPS_RATING[rating].tone}>
                        <Icon
                          name={rating === 'helpful' ? 'thumbUp' : 'thumbDown'}
                          className="size-4"
                        />
                        {OPS_RATING[rating].label}
                      </Badge>
                    )}
                  </span>
                }
              />
            );
          })}
        </List>
      )}
    </>
  );
}
