'use client';

import {
  BusinessSchema,
  CANCELLATION_POLICY_MAX,
  type BusinessProfile,
  type CancellationFees,
  type DepositAudience,
} from '@pepper/contracts';
import { brandTokens, Button, FOCUS_RING, Input, Segmented, Select, Textarea } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import {
  noteFrom,
  profileFields,
  profileFromFields,
  type ProfileFields,
} from '../../../lib/booking-profile';
import {
  FEE_CHOICES,
  policyFields,
  policyFrom,
  policyPreview,
  type FeeFields,
  type PolicyFields,
} from '../../../lib/cancellation-policy';
import { sendJson } from '../../../lib/client-api';
import {
  audienceSentence,
  DEPOSIT_AUDIENCE_CHOICES,
  refundChoices,
  refundHoursLabel,
  refundWindowSentence,
} from '../../../lib/deposits';
import { HELP_LINKS } from '../../../lib/help';
import { HelpLink } from '../help/help-link';
import { Notice } from '../form-parts';

/**
 * The business's public booking page (S17): its link, and for owners and managers its color
 * (PCR-001). Any color works: the page adjusts it until its text is readable (WCAG AA). On the
 * kit since S42.2: a quiet section, since nothing here waits on a decision. Since S47 also the
 * phone, address and cancellation policy clients see there (AC-W8-7), and since S66.2 the
 * deposit refund window (AC-X-112), where the deployment offers payments; since S67 who pays a
 * deposit (AC-X-125). Since S67.2 the cancellation policy Pepper writes from the owner's
 * choices (AC-X-130), with the refund window as its notice and the owner's note under it.
 */
export function BookingPageCard({
  slug,
  brandColor,
  profile,
  manages,
  deposits = null,
  policy,
}: {
  slug: string;
  brandColor: string | null;
  profile: BusinessProfile;
  manages: boolean;
  /** Who pays a deposit (S67); `null` hides it, and the policy's fees (payments off here). */
  deposits?: { audience: DepositAudience } | null;
  /** The policy's costs (`null`: off) and its notice, the refund window (S67.2). */
  policy: { fees: CancellationFees | null; noticeHours: number };
}) {
  const router = useRouter();
  const [color, setColor] = useState(brandColor ?? brandTokens(null).light.biz);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const path = `/book/${slug}`;
  const headingId = useId();

  async function save(next: string | null): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', { brandColor: next });
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setNotice({ tone: 'ok', text: next === null ? 'Back to the default color.' : 'Color saved.' });
    router.refresh();
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <h2 id={headingId} className="m-0 type-heading">
          Your booking page
        </h2>
        <HelpLink article={HELP_LINKS.bookingPage} />
      </div>
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4">
        <p className="m-0 type-body text-ink-2">
          Clients book here themselves, after confirming their email.{' '}
          <a
            href={path}
            target="_blank"
            rel="noreferrer"
            className={`font-semibold break-all text-brand ${FOCUS_RING}`}
          >
            {path}
          </a>
        </p>
        {manages ? (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 type-label text-ink">
              Color
              <input
                type="color"
                name="brandColor"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                }}
                className={`h-11 w-14 cursor-pointer rounded-md border border-line-strong bg-surface p-1 ${FOCUS_RING}`}
              />
            </label>
            <Button size="sm" busy={busy} onClick={() => void save(color)}>
              Save color
            </Button>
            {brandColor === null ? null : (
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void save(null)}>
                Use the default
              </Button>
            )}
          </div>
        ) : null}
        {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
        {manages ? <ProfileForm profile={profile} /> : null}
        {manages ? (
          <CancellationPolicyForm
            fees={policy.fees}
            noticeHours={policy.noticeHours}
            note={profile.cancellationPolicy}
            payments={deposits !== null}
          />
        ) : null}
        {manages && deposits !== null ? <DepositsForm audience={deposits.audience} /> : null}
      </div>
    </section>
  );
}

/**
 * What clients see about the business on its page (S47, AC-W8-7). Each field is optional: an
 * empty one isn't shown. Checked here first, so the message sits under the field to fix.
 */
function ProfileForm({ profile }: { profile: BusinessProfile }) {
  const router = useRouter();
  const [fields, setFields] = useState<ProfileFields>(() => profileFields(profile));
  const [errors, setErrors] = useState<Partial<Record<keyof ProfileFields, string>>>({});
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  const field = (key: keyof ProfileFields) => ({
    name: key,
    value: fields[key],
    error: errors[key],
    onChange: (event: { target: { value: string } }) => {
      setFields((current) => ({ ...current, [key]: event.target.value }));
    },
  });

  async function save(): Promise<void> {
    setNotice(null);
    const checked = profileFromFields(fields);
    if (!checked.ok) {
      setErrors(checked.errors);
      const first = Object.keys(checked.errors)[0];
      if (first !== undefined) document.getElementsByName(first)[0]?.focus();
      return;
    }
    setErrors({});
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', checked.profile);
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setFields(profileFields(parsed.data));
    setNotice({ tone: 'ok', text: 'Saved. Clients see these on your booking page.' });
    router.refresh();
  }

  return (
    <form
      aria-labelledby={headingId}
      noValidate
      className="flex flex-col gap-4 border-t border-line pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="m-0 type-subheading text-ink">
          What clients see
        </h3>
        <p className="m-0 type-body text-ink-2">Leave a field empty to keep it off the page.</p>
      </div>
      <Input
        label="Phone"
        type="tel"
        autoComplete="tel"
        inputMode="tel"
        placeholder="(555) 123-4567"
        {...field('phone')}
      />
      <Textarea
        label="Address"
        hint="Where clients come to you. Your mailing address stays private."
        rows={2}
        maxLength={300}
        placeholder={'12 Main St\nAustin, TX 78701'}
        {...field('publicAddress')}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" busy={busy}>
          Save details
        </Button>
      </div>
      {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
    </form>
  );
}

/**
 * Who pays a deposit (S67, AC-X-125). The refund window is the cancellation policy's notice
 * since S67.2 (one setting); a booking keeps the window it was made with (ADR-0068).
 */
function DepositsForm({ audience }: { audience: DepositAudience }) {
  const router = useRouter();
  const [who, setWho] = useState(audience);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  async function save(): Promise<void> {
    setNotice(null);
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', { depositAudience: who });
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setWho(parsed.data.depositAudience);
    setNotice({ tone: 'ok', text: 'Saved. New bookings follow this.' });
    router.refresh();
  }

  return (
    <form
      aria-labelledby={headingId}
      noValidate
      className="flex flex-col gap-4 border-t border-line pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="m-0 type-subheading text-ink">
          Deposits
        </h3>
        <p className="m-0 type-body text-ink-2">For services that take a deposit.</p>
      </div>
      <div className="flex flex-col gap-2">
        <span aria-hidden="true" className="type-label text-ink">
          Who pays a deposit
        </span>
        <Segmented
          label="Who pays a deposit"
          options={DEPOSIT_AUDIENCE_CHOICES}
          value={who}
          onValueChange={(next) => {
            const choice = DEPOSIT_AUDIENCE_CHOICES.find((option) => option.value === next);
            if (choice !== undefined) setWho(choice.value);
          }}
        />
        <p className="m-0 type-caption text-ink-2">{audienceSentence(who)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" busy={busy}>
          Save deposits
        </Button>
      </div>
      {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
    </form>
  );
}

const POLICY_CHOICES = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

/**
 * The cancellation policy (S67.2, AC-X-130/131): on or off, the notice (the refund window:
 * shown while the policy is on, or while deposits need it), what a later cancel and a no-show
 * cost (only where payments are offered: a fee is charged from a card, on the owner's OK in
 * S68), and the owner's note. Pepper's sentence is shown as clients will read it.
 */
function CancellationPolicyForm({
  fees,
  noticeHours,
  note,
  payments,
}: {
  fees: CancellationFees | null;
  noticeHours: number;
  note: string | null;
  payments: boolean;
}) {
  const router = useRouter();
  const [fields, setFields] = useState<PolicyFields>(() => policyFields(fees));
  const [hours, setHours] = useState(noticeHours);
  const [noteText, setNoteText] = useState(note ?? '');
  const [errors, setErrors] = useState<Partial<Record<'lateCancel' | 'noShow' | 'note', string>>>(
    {},
  );
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();
  const options = { noticeHours: hours, feesOffered: payments, stored: fees };
  const preview = policyPreview(fields, options);

  async function save(): Promise<void> {
    setNotice(null);
    const checked = policyFrom(fields, options);
    const typedNote = noteFrom(noteText);
    const found = {
      ...(checked.ok ? {} : checked.errors),
      ...(typedNote.ok ? {} : { note: typedNote.message }),
    };
    setErrors(found);
    if (!checked.ok || !typedNote.ok) {
      const first = Object.keys(found)[0];
      if (first !== undefined) document.getElementsByName(`policy-${first}`)[0]?.focus();
      return;
    }
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', {
      cancellationFees: checked.fees,
      cancellationPolicy: typedNote.note,
      ...(fields.on || payments ? { depositRefundHours: hours } : {}),
    });
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setFields(policyFields(parsed.data.cancellationFees));
    setHours(parsed.data.depositRefundHours);
    setNoteText(parsed.data.cancellationPolicy ?? '');
    setNotice({
      tone: 'ok',
      text:
        parsed.data.cancellationFees === null
          ? 'Saved.'
          : 'Saved. Clients see it when they book and in their emails.',
    });
    router.refresh();
  }

  const showNotice = fields.on || payments;
  const showFees = fields.on && payments;
  return (
    <form
      aria-labelledby={headingId}
      noValidate
      className="flex flex-col gap-4 border-t border-line pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="m-0 type-subheading text-ink">
          Cancellation policy
        </h3>
        <p className="m-0 type-body text-ink-2">
          Pick the rules. Pepper writes them for clients on your page and in every email.
        </p>
      </div>
      <Segmented
        label="Cancellation policy"
        options={POLICY_CHOICES}
        value={fields.on ? 'on' : 'off'}
        onValueChange={(next) => {
          setFields((current) => ({ ...current, on: next === 'on' }));
        }}
      />
      {showNotice ? (
        <Select
          label="Notice to cancel or reschedule"
          hint={payments ? refundWindowSentence(hours) : undefined}
          name="depositRefundHours"
          value={String(hours)}
          options={refundChoices(noticeHours).map((choice) => ({
            value: String(choice),
            label: choice === 0 ? refundHoursLabel(0) : `${refundHoursLabel(choice)} before`,
          }))}
          onChange={(event) => {
            setHours(Number(event.target.value));
          }}
        />
      ) : null}
      {showFees && hours > 0 ? (
        <FeeField
          legend="A later cancel costs"
          noun="Late cancel fee"
          name="policy-lateCancel"
          fields={fields.lateCancel}
          error={errors.lateCancel ?? null}
          onChange={(lateCancel) => {
            setFields((current) => ({ ...current, lateCancel }));
          }}
        />
      ) : null}
      {showFees ? (
        <FeeField
          legend="A no-show costs"
          noun="No-show fee"
          name="policy-noShow"
          fields={fields.noShow}
          error={errors.noShow ?? null}
          onChange={(noShow) => {
            setFields((current) => ({ ...current, noShow }));
          }}
        />
      ) : null}
      {fields.on && !payments ? (
        <p className="m-0 type-caption text-ink-2">
          Fees for late cancels and no-shows come with payments.
        </p>
      ) : null}
      {preview === null ? null : (
        <div
          className="flex flex-col gap-1 rounded-md bg-surface-2 p-3"
          aria-live="polite"
          data-testid="policy-preview"
        >
          <span className="type-caption text-ink-2">Clients read</span>
          <p className="m-0 type-body text-ink">{preview}</p>
        </div>
      )}
      {fields.on && showFees ? (
        <p className="m-0 type-caption text-ink-2">
          Nothing is charged by itself. Pepper asks you before any fee.
        </p>
      ) : null}
      <Textarea
        label="Anything else (optional)"
        hint={fields.on ? 'Shown under the rules above.' : 'Shown to clients as your policy.'}
        rows={3}
        maxLength={CANCELLATION_POLICY_MAX}
        placeholder="Running late? Call us and we’ll fit you in if we can."
        name="policy-note"
        value={noteText}
        error={errors.note}
        onChange={(event) => {
          setNoteText(event.target.value);
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" busy={busy}>
          Save policy
        </Button>
      </div>
      {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
    </form>
  );
}

/** One cost: nothing, an amount or a percent of the service's price, and its field. */
function FeeField({
  legend,
  noun,
  name,
  fields,
  error,
  onChange,
}: {
  legend: string;
  /** The field's own label, so the two costs' fields differ (review). */
  noun: string;
  name: string;
  fields: FeeFields;
  error: string | null;
  onChange: (fields: FeeFields) => void;
}) {
  const headingId = useId();
  return (
    <fieldset aria-labelledby={headingId} className="m-0 flex flex-col gap-3 border-0 p-0">
      <legend id={headingId} className="p-0 type-label text-ink">
        {legend}
      </legend>
      <Segmented
        label={legend}
        options={FEE_CHOICES}
        value={fields.kind}
        onValueChange={(kind) => {
          const next = FEE_CHOICES.find((choice) => choice.value === kind)?.value;
          if (next !== undefined) onChange({ ...fields, kind: next });
        }}
      />
      {fields.kind === 'fixed' ? (
        <Input
          label={`${noun} ($)`}
          name={name}
          inputMode="decimal"
          placeholder="20"
          value={fields.amount}
          error={error ?? undefined}
          onChange={(event) => {
            onChange({ ...fields, amount: event.target.value });
          }}
        />
      ) : null}
      {fields.kind === 'percent' ? (
        <Input
          label={`${noun} (% of the service price)`}
          name={name}
          inputMode="numeric"
          placeholder="50"
          value={fields.percent}
          error={error ?? undefined}
          onChange={(event) => {
            onChange({ ...fields, percent: event.target.value });
          }}
        />
      ) : null}
    </fieldset>
  );
}
