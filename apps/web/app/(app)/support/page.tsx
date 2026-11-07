import { SupportThreadListSchema } from '@pepper/contracts';
import { Badge, buttonStyle, EmptyState, List, ListRow } from '@pepper/ui';
import { screenshotCountLabel } from '../../../lib/support-screenshots';
import type { Metadata } from 'next';
import Link from 'next/link';
import {
  SUPPORT_KIND_LABEL,
  SUPPORT_PATHS,
  SUPPORT_STATUS,
  authorLabel,
  supportTime,
} from '../../../lib/support';
import { kitLink } from '../../_components/kit-link';
import { currentAccount, currentBusiness, currentJson } from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Your requests · Pepper' };

/**
 * "Your requests" (S59, PCR-010, AC-X-15): the support requests the member may read (staff
 * their own; owners and managers the business's), newest activity first, each with its status
 * in words and a mark when Pepper answered since they last looked.
 */
export default async function SupportRequestsPage() {
  // The app layout has sent anyone without a usable session elsewhere already.
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  const list =
    current === null ? null : await currentJson('/v1/support/threads', SupportThreadListSchema);
  const timeZone = current?.business.timeZone ?? 'UTC';
  const now = Date.now();
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="m-0 type-display">Your requests</h1>
          <p className="m-0 type-body text-ink-2">
            What you asked the Pepper team, and what we answered.
          </p>
        </div>
        {list === null || list.threads.length === 0 ? null : (
          <Link
            href={`${SUPPORT_PATHS.new}?from=${encodeURIComponent(SUPPORT_PATHS.list)}`}
            className={buttonStyle({ variant: 'primary' })}
          >
            New request
          </Link>
        )}
      </header>
      {current === null ? (
        <p className="m-0 rounded-lg bg-surface-2 px-5 py-4 type-body text-ink-2">
          Choose a business on More, and I’ll show its requests here.
        </p>
      ) : list === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t read your requests right now. Try again in a moment.
        </p>
      ) : list.threads.length === 0 ? (
        <EmptyState
          icon="help"
          title="No requests yet"
          body="Stuck on something, or have an idea? A person on the Pepper team answers the same day."
          action={{
            label: 'Tell us what went wrong',
            href: `${SUPPORT_PATHS.new}?from=${encodeURIComponent(SUPPORT_PATHS.list)}`,
            renderLink: kitLink,
          }}
        />
      ) : (
        <List>
          {list.threads.map((thread) => {
            const status = SUPPORT_STATUS[thread.status];
            const by = thread.openedBy.kind === 'you' ? null : authorLabel(thread.openedBy);
            return (
              <ListRow
                key={thread.id}
                href={SUPPORT_PATHS.thread(thread.id)}
                renderLink={kitLink}
                title={
                  <span className="flex items-center gap-2">
                    {thread.unread ? (
                      <span
                        className="size-2.5 shrink-0 rounded-pill bg-brand"
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className="truncate">{thread.preview}</span>
                    {thread.unread ? <span className="sr-only">(new answer)</span> : null}
                  </span>
                }
                meta={
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Badge tone={status.tone}>{status.label}</Badge>
                    <span className="tabular-nums">{thread.reference}</span>
                    <span>· {SUPPORT_KIND_LABEL[thread.kind]}</span>
                    {by === null ? null : <span>· {by}</span>}
                    {screenshotCountLabel(thread.screenshotCount) === null ? null : (
                      <span data-testid="support-row-screenshots">
                        · {screenshotCountLabel(thread.screenshotCount)}
                      </span>
                    )}
                    <span className="tabular-nums">
                      · {supportTime(thread.lastMessageAt, timeZone, now)}
                    </span>
                  </span>
                }
              />
            );
          })}
        </List>
      )}
    </div>
  );
}
