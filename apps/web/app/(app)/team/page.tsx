import {
  ServicesResponseSchema,
  StaffResponseSchema,
  WeeklyHoursSchema,
  type StaffMember,
} from '@pepper/contracts';
import { LegacyCard, cx } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requiredStep, ROUTES } from '../../../lib/account';
import { hoursSummary } from '../../../lib/setup';
import { AddStaffMember } from '../../_components/setup/staff-form';
import { TeamManager } from '../../_components/team-manager';
import { Unavailable } from '../../_components/unavailable';
import {
  currentAccount,
  currentBusiness,
  currentInvites,
  currentJson,
  currentMembers,
} from '../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Team · Pepper' };

/** The most staff members whose hours the list shows (one request each). */
const MAX_HOURS_LOOKUPS = 40;

/**
 * The team of the active business (S16): who can be booked, with their hours and services
 * (each opens their page), and the people with access to Pepper (roles, invites, leave). What
 * it offers follows the role's permissions from `GET /v1/tenant`; the api checks every action.
 */
export default async function TeamPage() {
  const account = await currentAccount();
  const step = requiredStep(account);
  if (step !== null) redirect(step);
  if (account.state !== 'signed-in') return <Unavailable />;
  const current = await currentBusiness();
  if (current === null) redirect(ROUTES.home);

  const { permissions } = current;
  const canSeeTeam = permissions.includes('members.read');
  const [members, invites, staffAnswer, servicesAnswer] = await Promise.all([
    canSeeTeam ? currentMembers() : null,
    canSeeTeam ? currentInvites() : null,
    permissions.includes('staff.read') ? currentJson('/v1/staff', StaffResponseSchema) : null,
    permissions.includes('services.read')
      ? currentJson('/v1/services', ServicesResponseSchema)
      : null,
  ]);
  const staff = staffAnswer?.staff ?? [];
  const services = servicesAnswer?.services ?? [];
  const hours = await Promise.all(
    staff
      .slice(0, MAX_HOURS_LOOKUPS)
      .map((member) => currentJson(`/v1/staff/${member.id}/hours`, WeeklyHoursSchema)),
  );
  const me = account.me.user.id;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="m-0 mb-5 font-display text-2xl font-bold">Team</h1>

      <section aria-labelledby="bookable-heading" className="mb-8 grid gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="bookable-heading" className="m-0 font-display text-lg font-bold">
              Who can be booked
            </h2>
            <p className="m-0 text-ink-2">Their hours, time off and the services they offer.</p>
          </div>
          {permissions.includes('staff.manage') ? (
            <AddStaffMember
              services={services}
              members={members}
              linkedUserIds={staff.flatMap((m) => (m.userId === null ? [] : [m.userId]))}
            />
          ) : null}
        </div>
        {staffAnswer === null && permissions.includes('staff.read') ? (
          <p role="alert" className="m-0 rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
            I couldn’t load who can be booked. Try again in a moment.
          </p>
        ) : null}
        {staffAnswer !== null && staff.length === 0 ? (
          <LegacyCard>
            <p className="m-0 text-ink-2">
              No one yet. Add yourself and anyone else clients can book, with their weekly hours.
            </p>
          </LegacyCard>
        ) : null}
        <ul className="m-0 grid list-none gap-3 p-0 desk:grid-cols-2" data-testid="staff-list">
          {staff.map((member, index) => (
            <StaffCard
              key={member.id}
              member={member}
              isMe={member.userId === me}
              hours={hours[index] ?? null}
              serviceNames={services
                .filter((service) => member.serviceIds.some((id) => id === service.id))
                .map((service) => service.name)}
            />
          ))}
        </ul>
      </section>

      <section aria-labelledby="access-heading" className="grid gap-3">
        <h2 id="access-heading" className="m-0 font-display text-lg font-bold">
          People with access
        </h2>
        <TeamManager
          me={me}
          role={current.role}
          businessName={current.business.name}
          timeZone={current.business.timeZone}
          permissions={permissions}
          members={members}
          invites={invites}
        />
      </section>
    </div>
  );
}

function StaffCard({
  member,
  isMe,
  hours,
  serviceNames,
}: {
  member: StaffMember;
  isMe: boolean;
  hours: { intervals: { weekday: number; start: string; end: string }[] } | null;
  serviceNames: string[];
}) {
  const summary = hours === null ? null : hoursSummary(hours);
  return (
    <li data-testid="staff-member">
      <Link
        href={`${ROUTES.team}/${member.id}`}
        className={cx(
          'grid h-full gap-1 rounded-lg border border-line bg-surface p-4 font-normal text-ink no-underline hover:bg-surface-2',
          !member.active && 'opacity-75',
        )}
      >
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-3 shrink-0 rounded-full"
            style={{ background: /^#[0-9a-f]{6}$/i.test(member.color) ? member.color : undefined }}
          />
          <strong className="truncate">{member.displayName}</strong>
          {isMe ? <span className="text-sm text-ink-2">(you)</span> : null}
          {member.active ? null : (
            <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold text-ink-2">
              Not bookable
            </span>
          )}
        </span>
        <span className="text-sm text-ink-2">
          {summary === null
            ? 'Hours not loaded'
            : summary.length === 0
              ? 'No hours set yet'
              : summary.join(' · ')}
        </span>
        <span className="text-sm text-ink-2">
          {serviceNames.length === 0 ? 'No services yet' : serviceNames.join(', ')}
        </span>
      </Link>
    </li>
  );
}
