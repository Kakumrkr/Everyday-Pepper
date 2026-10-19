import {
  ServicesResponseSchema,
  StaffMemberIdSchema,
  StaffResponseSchema,
  TimeOffResponseSchema,
  WeeklyHoursSchema,
} from '@pepper/contracts';
import { Card } from '@pepper/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ROUTES } from '../../../../lib/account';
import { hoursSummary, localDateIn } from '../../../../lib/setup';
import { HoursEditor } from '../../../_components/setup/hours-editor';
import { StaffForm } from '../../../_components/setup/staff-form';
import { TimeOffEditor } from '../../../_components/setup/time-off-editor';
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
 * and the staff member themselves, add and remove it). Everyone in the business may look.
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

  return (
    <div className="mx-auto max-w-2xl">
      <p className="m-0 mb-1">
        <Link href={ROUTES.team}>Team</Link>
      </p>
      {member === undefined ? (
        <p role="alert" className="rounded-md bg-wait-soft px-4 py-3 font-semibold text-wait">
          I couldn’t load this staff member. Try again in a moment.
        </p>
      ) : (
        <>
          <header className="mb-5 flex items-center gap-3">
            <span
              aria-hidden="true"
              className="size-4 shrink-0 rounded-full"
              style={{
                background: /^#[0-9a-f]{6}$/i.test(member.color) ? member.color : undefined,
              }}
            />
            <h1 className="m-0 font-display text-2xl font-bold">
              {member.displayName}
              {isMe ? <span className="ml-2 text-base font-normal text-ink-2">(you)</span> : null}
            </h1>
          </header>

          <div className="grid gap-4">
            <Card>
              <h2 className="m-0 mb-3 font-display text-lg font-bold">Details</h2>
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
                <dl className="m-0 grid gap-2">
                  <div>
                    <dt className="font-semibold">Services</dt>
                    <dd className="m-0 text-ink-2">
                      {offered.length === 0 ? 'None yet' : offered.map((s) => s.name).join(', ')}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold">Bookable</dt>
                    <dd className="m-0 text-ink-2">{member.active ? 'Yes' : 'Not right now'}</dd>
                  </div>
                </dl>
              )}
            </Card>

            <Card>
              <h2 className="m-0 font-display text-lg font-bold">Weekly hours</h2>
              <p className="mt-1 mb-3 text-ink-2">On the business’s clock ({timeZone}).</p>
              {hours === null ? (
                <p role="alert" className="m-0 font-semibold text-wait">
                  I couldn’t load the hours. Try again in a moment.
                </p>
              ) : managesHours ? (
                <HoursEditor staffMemberId={member.id} hours={hours} />
              ) : (
                <HoursList lines={hoursSummary(hours)} />
              )}
            </Card>

            <Card>
              <h2 className="m-0 mb-3 font-display text-lg font-bold">Time off</h2>
              {timeOff === null ? (
                <p role="alert" className="m-0 font-semibold text-wait">
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
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function HoursList({ lines }: { lines: string[] }) {
  if (lines.length === 0) return <p className="m-0 text-ink-2">No hours set yet.</p>;
  return (
    <ul className="m-0 grid list-none gap-1 p-0" data-testid="hours">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}
