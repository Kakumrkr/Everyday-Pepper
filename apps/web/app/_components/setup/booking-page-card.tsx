'use client';

import {
  BusinessSchema,
  CANCELLATION_POLICY_MAX,
  type BusinessProfile,
  type DepositAudience,
} from '@pepper/contracts';
import { brandTokens, Button, FOCUS_RING, Input, Segmented, Select, Textarea } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { profileFields, profileFromFields, type ProfileFields } from '../../../lib/booking-profile';
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
 * deposit (AC-X-125).
 */
export function BookingPageCard({
  slug,
  brandColor,
  profile,
  manages,
  deposits = null,
}: {
  slug: string;
  brandColor: string | null;
  profile: BusinessProfile;
  manages: boolean;
  /** The refund window (S66.2) and who pays (S67); `null` hides them (payments off here). */
  deposits?: { refundHours: number; audience: DepositAudience } | null;
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
        {manages && deposits !== null ? (
          <DepositsForm hours={deposits.refundHours} audience={deposits.audience} />
        ) : null}
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
      <Textarea
        label="Cancellation policy"
        hint="Clients see it before they book and on their confirmation."
        rows={3}
        maxLength={CANCELLATION_POLICY_MAX}
        placeholder="Please cancel or move at least 24 hours ahead."
        {...field('cancellationPolicy')}
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
 * The business's deposits (AC-X-112, S67 AC-X-125): who pays one, and how long before the start
 * a client may cancel and get it back. Saved together; a booking keeps the window it was made
 * with (ADR-0068).
 */
function DepositsForm({ hours, audience }: { hours: number; audience: DepositAudience }) {
  const router = useRouter();
  const [value, setValue] = useState(hours);
  const [who, setWho] = useState(audience);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  async function save(): Promise<void> {
    setNotice(null);
    setBusy(true);
    const answer = await sendJson('PUT', '/v1/tenant/booking-page', {
      depositRefundHours: value,
      depositAudience: who,
    });
    setBusy(false);
    const parsed = answer.ok ? BusinessSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setNotice({ tone: 'error', text: answer.ok ? 'Something went wrong.' : answer.message });
      return;
    }
    setValue(parsed.data.depositRefundHours);
    setWho(parsed.data.depositAudience);
    setNotice({ tone: 'ok', text: 'Saved. New bookings follow these.' });
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
      <Select
        label="Free cancellation until"
        hint={refundWindowSentence(value)}
        name="depositRefundHours"
        value={String(value)}
        options={refundChoices(hours).map((choice) => ({
          value: String(choice),
          label: choice === 0 ? refundHoursLabel(0) : `${refundHoursLabel(choice)} before`,
        }))}
        onChange={(event) => {
          setValue(Number(event.target.value));
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" busy={busy}>
          Save deposits
        </Button>
      </div>
      {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
    </form>
  );
}
