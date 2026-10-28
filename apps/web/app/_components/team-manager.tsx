'use client';

import type {
  CreateInviteResponse,
  Invite,
  Member,
  MembershipRole,
  Permission,
} from '@pepper/contracts';
import { Badge, Button, cx, fieldStyle, Input, Select } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../lib/account';
import { sendJson, type CallResult } from '../../lib/client-api';
import { formText } from '../../lib/form';
import { grantableRoles, inviteLink } from '../../lib/invite';
import { FormError } from './form-error';

const ROLE_LABELS: Record<MembershipRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
};

const ROW = 'flex min-h-14 flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3';

// A quiet block of the screen (nothing here is a decision card, DESIGN.md §2).
const BLOCK = 'flex flex-col gap-3 rounded-lg bg-surface p-4';

interface TeamManagerProps {
  me: string;
  role: MembershipRole;
  businessName: string;
  timeZone: string;
  permissions: Permission[];
  /** `null` when the role may not list the team (staff). */
  members: Member[] | null;
  invites: Invite[] | null;
}

/**
 * Lists the team and offers what the member's role allows: change roles, remove people, invite
 * with a link, cancel invites, and leave. Every action is checked again by the api. On the kit
 * since S42.2.
 */
export function TeamManager(props: TeamManagerProps) {
  const { me, role, businessName, permissions, members } = props;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  /** After a call: on success refreshes the page's data, else shows the message. */
  function settle(result: CallResult<unknown>): void {
    setError(result.ok ? null : result.message);
    if (result.ok) router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      {members === null ? null : (
        <section aria-label={`People at ${businessName}`} className={BLOCK}>
          <h3 className="m-0 type-subheading text-ink">People at {businessName}</h3>
          <ul className="m-0 list-none divide-y divide-line p-0" data-testid="members">
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                isMe={member.userId === me}
                myRole={role}
                canManage={permissions.includes('members.manage')}
                settle={settle}
              />
            ))}
          </ul>
        </section>
      )}
      <FormError message={error} />
      {permissions.includes('members.invite') ? <InviteSection {...props} settle={settle} /> : null}
      <LeaveBusiness me={me} businessName={businessName} />
    </div>
  );
}

function MemberRow({
  member,
  isMe,
  myRole,
  canManage,
  settle,
}: {
  member: Member;
  isMe: boolean;
  myRole: MembershipRole;
  canManage: boolean;
  settle: (result: CallResult<unknown>) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  // Only owners touch owners (the api's rule); others see an owner's row read-only.
  const editable = canManage && !isMe && (myRole === 'owner' || member.role !== 'owner');
  const roles = [...new Set([member.role, ...grantableRoles(myRole)])];
  const path = `/v1/members/${member.userId}`;
  return (
    <li className={ROW} data-testid="member">
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <span className="type-body font-semibold text-ink">{member.name}</span>
        {isMe ? <span className="type-caption text-ink-2"> (you)</span> : null}
        <span className="block type-caption text-ink-2">{member.email}</span>
      </div>
      {editable ? (
        <div className="flex flex-wrap items-center gap-2">
          <label className="visually-hidden" htmlFor={`role-${member.userId}`}>
            Role for {member.name}
          </label>
          <select
            id={`role-${member.userId}`}
            className={cx(fieldStyle, 'min-h-11 w-auto pr-8')}
            value={member.role}
            onChange={(event) => {
              void sendJson('PATCH', path, { role: event.target.value }).then(settle);
            }}
          >
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          {confirming ? (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() => void sendJson('DELETE', path, undefined).then(settle)}
              >
                Yes, remove {member.name}
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Remove {member.name}
            </Button>
          )}
        </div>
      ) : (
        <span data-testid="member-role">
          <Badge tone={member.role === 'owner' ? 'brand' : 'neutral'}>
            {ROLE_LABELS[member.role]}
          </Badge>
        </span>
      )}
    </li>
  );
}

function InviteSection({
  role,
  timeZone,
  invites,
  settle,
}: TeamManagerProps & { settle: (result: CallResult<unknown>) => void }) {
  const [created, setCreated] = useState<{ email: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const roles = grantableRoles(role);
  const expires = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  });

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    setCopied(false);
    const result = await sendJson<CreateInviteResponse>('POST', '/v1/invites', {
      email: formText(form, 'email'),
      role: formText(form, 'role'),
    });
    setBusy(false);
    settle(result);
    if (!result.ok) return;
    setCreated({
      email: result.data.invite.email,
      link: inviteLink(window.location.origin, result.data.token),
    });
    form.reset();
  }

  return (
    <section aria-label="Invite someone" className={BLOCK}>
      <h3 className="m-0 type-subheading text-ink">Invite someone</h3>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} noValidate>
        <Input label="Their email" name="email" type="email" autoComplete="off" required />
        <Select
          label="Role"
          name="role"
          defaultValue="staff"
          options={roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
        />
        <Button type="submit" busy={busy} className="w-full desk:w-auto desk:self-start">
          Create invite link
        </Button>
      </form>
      {created === null ? null : (
        <div className="flex flex-col gap-2 rounded-md bg-ok-soft p-3" role="status">
          <p className="m-0 type-body text-ink">
            Send this link to {created.email}. It works once, for 7 days, and only for that email.
          </p>
          <code data-testid="invite-link" className="type-caption break-all text-ink">
            {created.link}
          </code>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => {
              void navigator.clipboard.writeText(created.link).then(
                () => {
                  setCopied(true);
                },
                () => {
                  setCopied(false);
                },
              );
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      )}
      {invites === null || invites.length === 0 ? null : (
        <>
          <h4 className="m-0 mt-2 type-label text-ink">Waiting to join</h4>
          <ul className="m-0 list-none divide-y divide-line p-0" data-testid="invites">
            {invites.map((invite) => (
              <li className={ROW} key={invite.id} data-testid="invite">
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <span className="type-body font-semibold text-ink">{invite.email}</span>
                  <span className="block type-caption text-ink-2">
                    {ROLE_LABELS[invite.role]} · link works until{' '}
                    {expires.format(new Date(invite.expiresAt))}
                  </span>
                </div>
                {role === 'owner' || invite.role !== 'owner' ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void sendJson('DELETE', `/v1/invites/${invite.id}`, undefined).then(settle)
                    }
                  >
                    Cancel invite for {invite.email}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function LeaveBusiness({ me, businessName }: { me: string; businessName: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    const result = await sendJson('DELETE', `/v1/members/${me}`, undefined);
    if (!result.ok) {
      setError(result.message);
      setConfirming(false);
      return;
    }
    window.location.assign(ROUTES.home);
  }

  return (
    <section aria-label={`Leave ${businessName}`} className={BLOCK}>
      <h3 className="m-0 type-subheading text-ink">Leave {businessName}</h3>
      <p className="m-0 type-body text-ink-2">
        You’ll lose access to this business until someone invites you again.
      </p>
      <FormError message={error} />
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" size="sm" onClick={() => void leave()}>
            Yes, leave {businessName}
          </Button>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Leave {businessName}
        </Button>
      )}
    </section>
  );
}
