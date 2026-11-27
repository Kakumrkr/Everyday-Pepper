import {
  AiActionsResponseSchema,
  AiProposalsResponseSchema,
  DeletionStatusSchema,
  FeedResponseSchema,
  ImportBatchSchema,
  ProofResponseSchema,
  SetupReviewSchema,
  TasksResponseSchema,
} from '@pepper/contracts';
import { EmptyState, EveningWrap, WeekProof } from '@pepper/ui';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requiredStep } from '../../lib/account';
import { BUSINESS_DELETION_PATH, deletionDayLabel } from '../../lib/deletion';
import { needsReconnect } from '../../lib/calendar-connect';
import { offersImport } from '../../lib/imports';
import { MORE_HREF } from '../../lib/nav';
import {
  currentAccount,
  currentBusiness,
  currentCalendar,
  currentJson,
  currentMembers,
} from '../_server/account';
import { AiActivity } from '../_components/chat/ai-activity';
import { ReconnectCard } from '../_components/calendar-connect/reconnect-card';
import { HomeDeletionLine } from '../_components/deletion/home-deletion-line';
import { BriefingCard } from '../_components/feed/briefing-card';
import { ClientTextsCard } from '../_components/feed/client-texts-card';
import { FeedCard } from '../_components/feed/feed-card';
import { kitLink } from '../_components/kit-link';
import { SetupReviewCard } from '../_components/setup/setup-review-card';
import { TaskCard } from '../_components/tasks/task-card';
import { Unavailable } from '../_components/unavailable';

// Per request: the page depends on the session cookie.
export const dynamic = 'force-dynamic';

/**
 * Signed-in home, inside the app shell: the operator feed (S35, ADR-0039), as the card board
 * from S52 (ADR-0043: suggestions ranked by dollars and grouped, quiet before the first visit;
 * one line while the business is being deleted). Today's briefing
 * (S38a), Needs your OK (the AI's proposals), Suggestions (what the rules found, `/v1/feed`)
 * and Done for you (receipts), then what I did this week (S55), then the to-dos; from the
 * evening hour, tomorrow's wrap comes first (S55, ADR-0058). On the kit (S41): the plum briefing first, what
 * needs a decision raised, the rest flat; notifications and the account moved to More. Owners
 * and managers see the setup review first until it is checked, and anything that stops clients
 * from booking (S46); when it can't load, Home says nothing about setup rather than guess.
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
  const [setup, feed, imports, deletion, proof, calendar] = await Promise.all([
    current?.permissions.includes('settings.manage') === true
      ? currentJson('/v1/setup', SetupReviewSchema)
      : null,
    current?.permissions.includes('feed.read') === true
      ? currentJson('/v1/feed', FeedResponseSchema)
      : null,
    // "Bring your clients" after the setup check (S48.2, AC-W1-20): on the setup card, for
    // who may import.
    current?.permissions.includes('settings.manage') === true &&
    current.permissions.includes('clients.manage')
      ? currentJson('/v1/imports', z.array(ImportBatchSchema))
      : null,
    // A business being deleted says so in one quiet line (S52, AC-W1-45).
    current?.permissions.includes('business.read') === true
      ? currentJson(BUSINESS_DELETION_PATH, DeletionStatusSchema)
      : null,
    // Proof of value (S55, ADR-0058): the week and, in the evening, tomorrow; for the leads,
    // who hold the business's settings (the dollars and the names are the business's).
    current?.permissions.includes('settings.manage') === true
      ? currentJson('/v1/proof', ProofResponseSchema)
      : null,
    // The member's own Google Calendar, for the reconnect card (S70.2, AC-X-163).
    current?.permissions.includes('calendar.read') === true ? currentCalendar() : null,
  ]);
  const deletionDueAt = deletion?.dueAt ?? null;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        {current === null ? null : (
          <p className="m-0 type-label text-ink-2" data-testid="current-business">
            <span data-testid="business-name">{current.business.name}</span>
            {' · '}
            <span data-testid="business-role" className="capitalize">
              {current.role}
            </span>
          </p>
        )}
        <h1 className="m-0 type-display">Hi {me.user.name}</h1>
      </header>
      {current === null || deletionDueAt === null ? null : (
        <HomeDeletionLine
          name={current.business.name}
          dueLabel={deletionDayLabel(deletionDueAt, current.business.timeZone)}
          canKeep={current.permissions.includes('business.delete')}
        />
      )}
      {current !== null && calendar?.state === 'on' && needsReconnect(calendar.answer) ? (
        <ReconnectCard />
      ) : null}
      {current === null ? (
        <EmptyState
          icon="home"
          title="Choose a business"
          body="Pick the business to work in, and I’ll show you its day."
          action={{ label: 'Choose a business', href: MORE_HREF, renderLink: kitLink }}
        />
      ) : null}
      {current !== null && setup !== null ? (
        <SetupReviewCard
          review={setup}
          slug={current.business.slug}
          offersImport={imports !== null && offersImport(imports)}
        />
      ) : null}
      {current !== null && proof !== null ? (
        <EveningWrap evening={proof.evening} timeZone={current.business.timeZone} />
      ) : null}
      {current !== null && feed !== null ? (
        <BriefingCard feed={feed} timeZone={current.business.timeZone} />
      ) : null}
      {current !== null && feed !== null ? (
        <ClientTextsCard
          feed={feed}
          businessName={current.business.name}
          timeZone={current.business.timeZone}
        />
      ) : null}
      {current !== null && proposals !== null && actions !== null ? (
        <AiActivity
          section="needs"
          proposals={proposals.proposals}
          actions={actions.actions}
          timeZone={current.business.timeZone}
        />
      ) : null}
      {current !== null && feed !== null ? (
        <FeedCard feed={feed} timeZone={current.business.timeZone} />
      ) : null}
      {current !== null && proposals !== null && actions !== null ? (
        <AiActivity
          section="done"
          proposals={proposals.proposals}
          actions={actions.actions}
          timeZone={current.business.timeZone}
        />
      ) : null}
      {proof === null ? null : <WeekProof week={proof.week} />}
      {current !== null && open !== null && done !== null ? (
        <TaskCard
          open={open.tasks}
          done={done.tasks}
          me={me.user.id}
          members={members}
          timeZone={current.business.timeZone}
          now={Date.now()}
        />
      ) : null}
    </div>
  );
}
