import {
  ServicesResponseSchema,
  StaffResponseSchema,
  WeeklyHoursSchema,
  type StaffMember,
} from '@pepper/contracts';
import { Badge, cx, FOCUS_RING, Icon } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requiredStep, ROUTES } from '../../../lib/account';
import { activeStaffTone, type StaffTone } from '../../../lib/calendar';
import { hoursSummary } from '../../../lib/setup';
import { BookableStaff } from '../../_components/setup/bookable-staff';
import { StaffToneDot } from '../../_components/staff-tone';
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
 * On the kit since S42.2: hairline rows with each member's calendar tone, and an empty list
 * that offers its next step (AC-X-7).
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
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <h1 className="m-0 type-display">Team</h1>

      <BookableStaff
        adds={permissions.includes('staff.manage')}
        state={
          staffAnswer === null
            ? permissions.includes('staff.read')
              ? 'failed'
              : 'listed'
            : staff.length === 0
              ? 'empty'
              : 'listed'
        }
        services={services}
        members={members}
        linkedUserIds={staff.flatMap((m) => (m.userId === null ? [] : [m.userId]))}
      >
        {staff.length === 0 ? null : (
          <ul
            className="m-0 list-none divide-y divide-line rounded-lg bg-surface p-0 px-4"
            data-testid="staff-list"
          >
            {staff.map((member, index) => (
              <StaffRow
                key={member.id}
                member={member}
                tone={activeStaffTone(staff, member.id)}
                isMe={member.userId === me}
                hours={hours[index] ?? null}
                serviceNames={services
                  .filter((service) => member.serviceIds.some((id) => id === service.id))
                  .map((service) => service.name)}
              />
            ))}
          </ul>
        )}
      </BookableStaff>

      <section aria-labelledby="access-heading" className="flex flex-col gap-3">
        <h2 id="access-heading" className="m-0 type-heading">
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

/** One bookable member as a hairline row that opens their page; the tone dot as on the calendar. */
function StaffRow({
  member,
  tone,
  isMe,
  hours,
  serviceNames,
}: {
  member: StaffMember;
  tone: StaffTone | null;
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
          '-mx-2 flex min-h-14 items-center gap-3 rounded-sm px-2 py-3 font-normal text-ink no-underline hover:bg-surface-2',
          FOCUS_RING,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-2 type-body font-semibold">
            {tone === null ? null : <StaffToneDot tone={tone} />}
            <span className="truncate">{member.displayName}</span>
            {isMe ? <span className="type-caption font-normal text-ink-2">(you)</span> : null}
            {member.active ? null : <Badge>Not bookable</Badge>}
          </span>
          <span className="type-caption text-ink-2 tabular-nums">
            {summary === null
              ? 'Hours not loaded'
              : summary.length === 0
                ? 'No hours set yet'
                : summary.join(' · ')}
          </span>
          <span className="type-caption text-ink-2">
            {serviceNames.length === 0 ? 'No services yet' : serviceNames.join(', ')}
          </span>
        </span>
        <Icon name="right" className="text-ink-3" />
      </Link>
    </li>
  );
}
