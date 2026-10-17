'use client';

import type {
  CreateInviteResponse,
  Invite,
  Member,
  MembershipRole,
  Permission,
} from '@floty/contracts';
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
 * with a link, cancel invites, and leave. Every action is checked again by the api.
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
    <div className="team">
      {members === null ? null : (
        <section aria-labelledby="members-heading">
          <h2 id="members-heading">People at {businessName}</h2>
          <ul className="rows" data-testid="members">
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
    <li className="row" data-testid="member">
      <div>
        <strong>{member.name}</strong>
        {isMe ? <span className="hint"> (you)</span> : null}
        <span className="hint block">{member.email}</span>
      </div>
      {editable ? (
        <div className="row-actions">
          <label className="visually-hidden" htmlFor={`role-${member.userId}`}>
            Role for {member.name}
          </label>
          <select
            id={`role-${member.userId}`}
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
              <button
                type="button"
                onClick={() => void sendJson('DELETE', path, undefined).then(settle)}
              >
                Yes, remove {member.name}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Remove {member.name}
            </button>
          )}
        </div>
      ) : (
        <span className="pill" data-testid="member-role">
          {ROLE_LABELS[member.role]}
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
    <section aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite someone</h2>
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <label>
          Their email
          <input name="email" type="email" autoComplete="off" required />
        </label>
        <label>
          Role
          <select name="role" defaultValue="staff">
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          Create invite link
        </button>
      </form>
      {created === null ? null : (
        <div className="invite-link" role="status">
          <p className="hint">
            Send this link to {created.email}. It works once, for 7 days, and only for that email.
          </p>
          <code data-testid="invite-link">{created.link}</code>
          <button
            type="button"
            className="secondary"
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
          </button>
        </div>
      )}
      {invites === null || invites.length === 0 ? null : (
        <>
          <h3>Waiting to join</h3>
          <ul className="rows" data-testid="invites">
            {invites.map((invite) => (
              <li className="row" key={invite.id} data-testid="invite">
                <div>
                  <strong>{invite.email}</strong>
                  <span className="hint block">
                    {ROLE_LABELS[invite.role]} · link works until{' '}
                    {expires.format(new Date(invite.expiresAt))}
                  </span>
                </div>
                {role === 'owner' || invite.role !== 'owner' ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      void sendJson('DELETE', `/v1/invites/${invite.id}`, undefined).then(settle)
                    }
                  >
                    Cancel invite for {invite.email}
                  </button>
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
    <section aria-labelledby="leave-heading" className="leave">
      <h2 id="leave-heading">Leave {businessName}</h2>
      <p className="hint">You’ll lose access to this business until someone invites you again.</p>
      <FormError message={error} />
      {confirming ? (
        <div className="row-actions">
          <button type="button" onClick={() => void leave()}>
            Yes, leave {businessName}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Leave {businessName}
        </button>
      )}
    </section>
  );
}
