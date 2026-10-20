import { TasksResponseSchema } from '@pepper/contracts';
import { redirect } from 'next/navigation';
import { requiredStep } from '../../lib/account';
import { currentAccount, currentBusiness, currentJson, currentMembers } from '../_server/account';
import { BusinessSwitcher, SignOutButton } from '../_components/account-actions';
import { NotificationsCard } from '../_components/push/notifications-card';
import { TaskCard } from '../_components/tasks/task-card';
import { Unavailable } from '../_components/unavailable';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/** Signed-in home, inside the app shell. Phase 8 replaces the body with the operator feed. */
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
  return (
    <div className="mx-auto max-w-xl">
      <h1>Hi {me.user.name}</h1>
      <p className="tagline">Your AI employee is getting ready.</p>
      {current === null ? (
        <p className="status">Choose a business below.</p>
      ) : (
        <p className="status" data-state="ok" data-testid="current-business">
          <span data-testid="business-name">{current.business.name}</span>
          <span data-testid="business-role">{current.role}</span>
        </p>
      )}
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
