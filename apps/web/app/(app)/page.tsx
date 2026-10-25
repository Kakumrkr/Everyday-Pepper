import {
  AiActionsResponseSchema,
  AiProposalsResponseSchema,
  FeedResponseSchema,
  TasksResponseSchema,
} from '@pepper/contracts';
import { redirect } from 'next/navigation';
import { requiredStep } from '../../lib/account';
import { currentAccount, currentBusiness, currentJson, currentMembers } from '../_server/account';
import { BusinessSwitcher, SignOutButton } from '../_components/account-actions';
import { AiActivity } from '../_components/chat/ai-activity';
import { BriefingCard } from '../_components/feed/briefing-card';
import { FeedCard } from '../_components/feed/feed-card';
import { NotificationsCard } from '../_components/push/notifications-card';
import { TaskCard } from '../_components/tasks/task-card';
import { Unavailable } from '../_components/unavailable';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/**
 * Signed-in home, inside the app shell: the operator feed (S35, ADR-0039). Today's briefing
 * (S38a), Needs your OK (the AI's proposals), Suggestions (what the rules found, `/v1/feed`)
 * and Done for you (receipts), then the to-dos and notifications.
 */
export default async function HomePage() {
  const account = await currentAccount();
  const step = requiredStep(account);
  if (step !== null) redirect(step);
  if (account.state !== 'signed-in') return <Unavailable />;

  const { me } = account;
  const current = await currentBusiness();
  const showsTasks = current?.permissions.includes('tasks.read') === true;
  const [open, done, members] = showsTasks
    ? await Promise.all([
        currentJson('/v1/tasks?status=open', TasksResponseSchema),
        currentJson('/v1/tasks?status=done&limit=5', TasksResponseSchema),
        // Owners and managers may list the team, and so give a to-do to anyone.
        current.permissions.includes('members.read') ? currentMembers() : null,
      ])
    : [null, null, null];
  // Pepper's work: what waits for an OK and "Done for you" (S26).
  const showsAi = current?.permissions.includes('ai.chat') === true;
  const [proposals, actions] = showsAi
    ? await Promise.all([
        currentJson('/v1/ai/proposals', AiProposalsResponseSchema),
        currentJson('/v1/ai/actions', AiActionsResponseSchema),
      ])
    : [null, null];
  const feed =
    current?.permissions.includes('feed.read') === true
      ? await currentJson('/v1/feed', FeedResponseSchema)
      : null;
  return (
    <div className="mx-auto max-w-xl">
      <h1>Hi {me.user.name}</h1>
      {current === null ? (
        <p className="status">Choose a business below.</p>
      ) : (
        <p className="status" data-state="ok" data-testid="current-business">
          <span data-testid="business-name">{current.business.name}</span>
          <span data-testid="business-role">{current.role}</span>
        </p>
      )}
      {current !== null && feed !== null ? (
        <div className="mt-6 empty:hidden">
          <BriefingCard feed={feed} timeZone={current.business.timeZone} />
        </div>
      ) : null}
      {current !== null && proposals !== null && actions !== null ? (
        <div className="mt-6">
          <AiActivity
            section="needs"
            proposals={proposals.proposals}
            actions={actions.actions}
            timeZone={current.business.timeZone}
          />
        </div>
      ) : null}
      {current !== null && feed !== null ? (
        <div className="mt-6">
          <FeedCard feed={feed} timeZone={current.business.timeZone} />
        </div>
      ) : null}
      {current !== null && proposals !== null && actions !== null ? (
        <div className="mt-6">
          <AiActivity
            section="done"
            proposals={proposals.proposals}
            actions={actions.actions}
            timeZone={current.business.timeZone}
          />
        </div>
      ) : null}
      {current !== null && open !== null && done !== null ? (
        <div className="mt-6">
          <TaskCard
            open={open.tasks}
            done={done.tasks}
            me={me.user.id}
            members={members}
            timeZone={current.business.timeZone}
            now={Date.now()}
          />
        </div>
      ) : null}
      {current === null ? null : (
        <div className="mt-6">
          <NotificationsCard />
        </div>
      )}
      {me.businesses.length > 1 || current === null ? (
        <BusinessSwitcher businesses={me.businesses} activeTenantId={me.activeTenantId} />
      ) : null}
      <div className="actions">
        <SignOutButton />
      </div>
    </div>
  );
}
