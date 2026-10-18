import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requiredStep, ROUTES } from '../../../lib/account';
import { TeamManager } from '../../_components/team-manager';
import { Unavailable } from '../../_components/unavailable';
import {
  currentAccount,
  currentBusiness,
  currentInvites,
  currentMembers,
} from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Team · Floty' };

/**
 * The team of the active business (Phase 2: list, roles, remove, leave, invite links). What it
 * offers follows the role's permissions from `GET /v1/tenant`; the api checks every action.
 * Phase 4 adds services and hours per member.
 */
export default async function TeamPage() {
  const account = await currentAccount();
  const step = requiredStep(account);
  if (step !== null) redirect(step);
  if (account.state !== 'signed-in') return <Unavailable />;
  const current = await currentBusiness();
  if (current === null) redirect(ROUTES.home);

  const canSeeTeam = current.permissions.includes('members.read');
  const [members, invites] = canSeeTeam
    ? await Promise.all([currentMembers(), currentInvites()])
    : [null, null];
  return (
    <div className="mx-auto max-w-xl">
      <h1>Team</h1>
      <TeamManager
        me={account.me.user.id}
        role={current.role}
        businessName={current.business.name}
        timeZone={current.business.timeZone}
        permissions={current.permissions}
        members={members}
        invites={invites}
      />
    </div>
  );
}
