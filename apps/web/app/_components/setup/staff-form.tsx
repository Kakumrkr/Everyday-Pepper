'use client';

import { StaffMemberSchema, type Member, type Service, type StaffMember } from '@pepper/contracts';
import { buttonClass, cx, Icon } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type SubmitEvent } from 'react';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { STAFF_COLORS } from '../../../lib/setup';
import { Field, Notice, Sheet } from '../booking/sheet';

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
export function AddStaffMember(props: Omit<StaffFormProps, 'member'>) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  return (
    <Sheet
      title="Add someone who can be booked"
      description="Then set their weekly hours."
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button type="button" className={buttonClass({ size: 'sm' })}>
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
 * A staff member's name, calendar colour, app login and the services they offer
 * (`POST /v1/staff`, or `PUT /v1/staff/:id` with every field). Owners and managers only.
 */
export function StaffForm({ member, services, members, linkedUserIds }: StaffFormProps) {
  const router = useRouter();
  const [color, setColor] = useState(member?.color ?? STAFF_COLORS[0].value);
  const [message, setMessage] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const logins = (members ?? []).filter(
    (m) => m.userId === member?.userId || !linkedUserIds.includes(m.userId),
  );
  const colors = STAFF_COLORS.some((c) => c.value === color)
    ? STAFF_COLORS
    : [...STAFF_COLORS, { value: color, name: 'Current' }];

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const userId = formText(form, 'userId');
    const body = {
      displayName: formText(form, 'displayName'),
      color,
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
    <form className="grid gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Field label="Name" hint="As clients see it, e.g. Jess or Dr. Lee.">
        <input
          name="displayName"
          required
          maxLength={80}
          defaultValue={member?.displayName ?? ''}
        />
      </Field>

      <fieldset className="m-0 grid gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 font-semibold">Calendar colour</legend>
        <div className="flex flex-wrap gap-2">
          {colors.map((choice) => (
            <label
              key={choice.value}
              className={cx(
                'flex size-11 cursor-pointer items-center justify-center rounded-full border-2',
                'has-[input:focus-visible]:outline-3 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-brand',
                choice.value === color ? 'border-ink' : 'border-transparent',
              )}
            >
              <input
                type="radio"
                name="color"
                value={choice.value}
                checked={choice.value === color}
                onChange={() => {
                  setColor(choice.value);
                }}
                className="visually-hidden"
              />
              <span
                aria-hidden="true"
                className="size-8 rounded-full"
                style={{ background: choice.value }}
              />
              <span className="visually-hidden">{choice.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {members === null ? null : (
        <Field
          label="Their Pepper login"
          hint="Linking a login lets them see their own appointments and add their time off."
        >
          <select name="userId" defaultValue={member?.userId ?? ''}>
            <option value="">They don’t sign in</option>
            {logins.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.name} ({m.email})
              </option>
            ))}
          </select>
        </Field>
      )}

      <fieldset className="m-0 grid gap-1 border-0 p-0">
        <legend className="mb-1.5 p-0 font-semibold">Services they offer</legend>
        {services.length === 0 ? (
          <p className="m-0 text-ink-2">No services yet. Add them on the Services page.</p>
        ) : (
          services.map((service) => (
            <label key={service.id} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                name="serviceIds"
                value={service.id}
                defaultChecked={member?.serviceIds.some((id) => id === service.id) ?? false}
                className="size-5 min-h-0 w-auto accent-brand"
              />
              {service.name}
              {service.active ? null : <span className="text-sm text-ink-2">(not bookable)</span>}
            </label>
          ))
        )}
      </fieldset>

      <label className="flex min-h-11 items-center gap-3 font-semibold">
        <input
          name="active"
          type="checkbox"
          defaultChecked={member?.active ?? true}
          className="size-5 min-h-0 w-auto accent-brand"
        />
        Can be booked
      </label>

      {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      <button
        type="submit"
        disabled={busy}
        className={buttonClass({ className: 'w-full desk:w-auto desk:justify-self-start' })}
      >
        {busy ? 'Saving…' : member === undefined ? 'Add' : 'Save details'}
      </button>
    </form>
  );
}
