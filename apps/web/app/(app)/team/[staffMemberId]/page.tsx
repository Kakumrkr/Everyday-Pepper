import {
  ServicesResponseSchema,
  StaffMemberIdSchema,
  StaffResponseSchema,
  TimeOffResponseSchema,
  WeeklyHoursSchema,
} from '@pepper/contracts';
import { Badge, buttonStyle, cx, DetailTable, Icon } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { activeStaffTone } from '../../../../lib/calendar';
import { hoursSummary, localDateIn } from '../../../../lib/setup';
import { HoursEditor } from '../../../_components/setup/hours-editor';
import { StaffForm } from '../../../_components/setup/staff-form';
import { TimeOffEditor } from '../../../_components/setup/time-off-editor';
import { StaffToneDot } from '../../../_components/staff-tone';
import {
  currentAccount,
  currentBusiness,
  currentJson,
  currentMembers,
} from '../../../_server/account';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Team · Pepper' };

/**
 * One staff member (S16): their details and services (owners and managers edit them), their
 * weekly hours (owners and managers edit them) and their coming time off (owners and managers,
 * and the staff member themselves, add and remove it). Everyone in the business may look. On
 * the kit since S42.2: their calendar tone by the name, then quiet sections.
 */
export default async function StaffMemberPage({
  params,
}: {
  params: Promise<{ staffMemberId: string }>;
}) {
  const account = await currentAccount();
  if (account.state !== 'signed-in') return null;
  const current = await currentBusiness();
  if (!current?.permissions.includes('staff.read')) redirect(ROUTES.home);
  const id = StaffMemberIdSchema.safeParse((await params).staffMemberId);
  if (!id.success) notFound();

  const { permissions } = current;
  const [staff, services, hours, timeOff, members] = await Promise.all([
    currentJson('/v1/staff', StaffResponseSchema),
    currentJson('/v1/services', ServicesResponseSchema),
    currentJson(`/v1/staff/${id.data}/hours`, WeeklyHoursSchema),
    currentJson(`/v1/staff/${id.data}/time-off`, TimeOffResponseSchema),
    permissions.includes('members.read') ? currentMembers() : null,
  ]);
  const member = staff?.staff.find((m) => m.id === id.data);
  if (staff !== null && member === undefined) notFound();

  const { timeZone } = current.business;
  const isMe = member?.userId === account.me.user.id;
  const managesStaff = permissions.includes('staff.manage');
  const managesHours = permissions.includes('hours.manage');
  // Staff manage only their own time off (the api checks it again).
  const managesTimeOff =
    permissions.includes('time_off.manage') && (current.role !== 'staff' || isMe);
  const offered = (services?.services ?? []).filter((s) =>
    member?.serviceIds.some((serviceId) => serviceId === s.id),
  );

  const tone = member === undefined ? null : activeStaffTone(staff?.staff ?? [], member.id);
  const block = 'flex flex-col gap-3 rounded-lg bg-surface p-4';

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        href={ROUTES.team}
        className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-3 self-start')}
      >
        <Icon name="left" />
        Team
      </Link>
      {member === undefined ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load this staff member. Try again in a moment.
        </p>
      ) : (
        <>
          <header className="flex flex-col gap-1">
            <h1 className="m-0 flex flex-wrap items-center gap-3 type-display">
              {tone === null ? null : <StaffToneDot tone={tone} className="size-4" />}
              {member.displayName}
              {isMe ? <span className="type-body font-normal text-ink-2">(you)</span> : null}
            </h1>
            <p className="m-0 flex flex-wrap items-center gap-2 type-body text-ink-2">
              {member.active ? (
                'Bookable, with this color on the calendar.'
              ) : (
                <>
                  <Badge>Not bookable</Badge> Not on the calendar or the booking page right now.
                </>
              )}
            </p>
          </header>

          <section aria-labelledby="staff-details" className="flex flex-col gap-3">
            <h2 id="staff-details" className="m-0 type-heading">
              Details
            </h2>
            <div className={block}>
              {managesStaff ? (
                <StaffForm
                  member={member}
                  services={services?.services ?? []}
                  members={members}
                  linkedUserIds={(staff?.staff ?? []).flatMap((m) =>
                    m.userId === null || m.id === member.id ? [] : [m.userId],
                  )}
                />
              ) : (
                <DetailTable
                  rows={[
                    {
                      label: 'Services',
                      value:
                        offered.length === 0 ? 'None yet' : offered.map((s) => s.name).join(', '),
                    },
                    { label: 'Bookable', value: member.active ? 'Yes' : 'Not right now' },
                  ]}
                />
              )}
            </div>
          </section>

          <section aria-labelledby="staff-hours" className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="staff-hours" className="m-0 type-heading">
                Weekly hours
              </h2>
              <p className="m-0 type-body text-ink-2">On the business’s clock ({timeZone}).</p>
            </div>
            <div className={block}>
              {hours === null ? (
                <p role="alert" className="m-0 type-body font-semibold text-warn">
                  I couldn’t load the hours. Try again in a moment.
                </p>
              ) : managesHours ? (
                <HoursEditor staffMemberId={member.id} hours={hours} />
              ) : (
                <HoursList lines={hoursSummary(hours)} />
              )}
            </div>
          </section>

          <section aria-labelledby="staff-time-off" className="flex flex-col gap-3">
            <h2 id="staff-time-off" className="m-0 type-heading">
              Time off
            </h2>
            <div className={block}>
              {timeOff === null ? (
                <p role="alert" className="m-0 type-body font-semibold text-warn">
                  I couldn’t load the time off. Try again in a moment.
                </p>
              ) : (
                <TimeOffEditor
                  staffMemberId={member.id}
                  timeZone={timeZone}
                  entries={timeOff.timeOff}
                  manages={managesTimeOff}
                  today={localDateIn(timeZone, Date.now())}
                />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function HoursList({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return (
      <p className="m-0 type-body text-ink-2">
        No hours set yet. An owner or manager sets them here.
      </p>
    );
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="hours">
      {lines.map((line) => (
        <li key={line} className="type-body text-ink tabular-nums">
          {line}
        </li>
      ))}
    </ul>
  );
}
