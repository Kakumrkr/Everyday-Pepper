'use client';

import { StaffMemberSchema, type Member, type Service, type StaffMember } from '@pepper/contracts';
import { Button, buttonStyle, Checkbox, Icon, Input, Select, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { STAFF_COLOR } from '../../../lib/setup';
import { Notice } from '../form-parts';

interface StaffFormProps {
  /** The staff member to edit; none adds a new one. */
  member?: StaffMember;
  services: Service[];
  /** The business's members, to link a login (`null`: the role may not list them). */
  members: Member[] | null;
  /** Logins already linked to another staff member (not offered again). */
  linkedUserIds: string[];
}

/** "Add staff member" on the Team page: a sheet, then the new member's page for their hours. */
export function AddStaffMember({
  open: shown,
  onOpenChange,
  returnFocus,
  ...props
}: Omit<StaffFormProps, 'member'> & {
  /** Opened from elsewhere too (the empty list's "Add the first person"). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes on close when another button opened it (Sheet's `returnFocus`). */
  returnFocus?: (() => HTMLElement | null) | undefined;
}) {
  const [own, setOwn] = useState(false);
  const open = shown ?? own;
  const setOpen = onOpenChange ?? setOwn;
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title="Add someone who can be booked"
      description="Then set their weekly hours."
      open={open}
      returnFocus={returnFocus}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonStyle({ size: 'sm' })}>
          <Icon name="plus" />
          Add staff member
        </button>
      }
    >
      <StaffForm key={key} {...props} />
    </Sheet>
  );
}

/**
 * A staff member's name, app login and the services they offer (`POST /v1/staff`, or
 * `PUT /v1/staff/:id` with every field). Owners and managers only. No colour to pick (S42.2,
 * D-2): the calendar gives each active member a tone by their place, so the stored colour is
 * only sent back as it was. In the add sheet, Save sits in the sheet's footer (D3).
 */
export function StaffForm({ member, services, members, linkedUserIds }: StaffFormProps) {
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const logins = (members ?? []).filter(
    (m) => m.userId === member?.userId || !linkedUserIds.includes(m.userId),
  );

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const userId = formText(form, 'userId');
    const body = {
      displayName: formText(form, 'displayName'),
      color: member?.color ?? STAFF_COLOR,
      active: data.get('active') !== null,
      // Without the list (it could not be loaded), the link stays as it was.
      userId: members === null ? (member?.userId ?? null) : userId === '' ? null : userId,
      serviceIds: data.getAll('serviceIds').map(String),
    };
    setBusy(true);
    const answer =
      member === undefined
        ? await sendJson('POST', '/v1/staff', body)
        : await sendJson('PUT', `/v1/staff/${member.id}`, body);
    setBusy(false);
    const saved = answer.ok ? StaffMemberSchema.safeParse(answer.data) : null;
    if (saved?.success !== true) {
      setMessage({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    if (member === undefined) {
      router.push(`${ROUTES.team}/${saved.data.id}`);
      return;
    }
    setMessage({ tone: 'ok', text: 'Saved.' });
    router.refresh();
  }

  return (
    <form id={formId} className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        label="Name"
        hint="As clients see it, e.g. Jess or Dr. Lee."
        name="displayName"
        required
        maxLength={80}
        defaultValue={member?.displayName ?? ''}
      />

      {members === null ? null : (
        <Select
          label="Their Pepper login"
          hint="Linking a login lets them see their own appointments and add their time off."
          name="userId"
          defaultValue={member?.userId ?? ''}
          options={[
            { value: '', label: 'They don’t sign in' },
            ...logins.map((m) => ({ value: m.userId, label: `${m.name} (${m.email})` })),
          ]}
        />
      )}

      <fieldset className="m-0 flex flex-col border-0 p-0">
        <legend className="mb-1 p-0 type-label text-ink">Services they offer</legend>
        {services.length === 0 ? (
          <p className="m-0 type-body text-ink-2">
            No services yet. Add them on the Services page.
          </p>
        ) : (
          services.map((service) => (
            <Checkbox
              key={service.id}
              name="serviceIds"
              value={service.id}
              label={service.active ? service.name : `${service.name} (not bookable)`}
              defaultChecked={member?.serviceIds.some((id) => id === service.id) ?? false}
            />
          ))
        )}
      </fieldset>

      <Checkbox
        name="active"
        label="Can be booked"
        hint="Shown on the calendar and the booking page."
        defaultChecked={member?.active ?? true}
      />

      <SheetFooter>
        {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
        <Button
          type="submit"
          form={formId}
          busy={busy}
          size="lg"
          className="w-full desk:w-auto desk:self-start desk:justify-self-start"
        >
          {busy ? 'Saving…' : member === undefined ? 'Add' : 'Save details'}
        </Button>
      </SheetFooter>
    </form>
  );
}
