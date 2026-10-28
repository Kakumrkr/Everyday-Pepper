'use client';

import {
  BookingConfirmResponseSchema,
  BookingRequestResponseSchema,
  SlotUnavailableSchema,
  WaitlistConfirmResponseSchema,
  WrongCodeSchema,
  type AvailableSlot,
  type BookingConfirmResponse,
  type PublicBusiness,
  type WaitlistConfirmResponse,
} from '@pepper/contracts';
import {
  Button,
  buttonStyle,
  chipStyle,
  cx,
  DetailTable,
  FOCUS_RING,
  Icon,
  Input,
  List,
  StepBar,
  StickyActionBar,
} from '@pepper/ui';
import { useId, useMemo, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { dateTimeLabel, timeLabel } from '../../../lib/booking';
import { sendJson, type CallResult } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import {
  checkDetails,
  confirmProblem,
  managePath,
  publicApiPath,
  serviceOf,
  staffFor,
  type ClientDetails,
} from '../../../lib/public-booking';
import { durationLabel, priceLabel, servicesByCategory } from '../../../lib/setup';
import { Notice } from '../form-parts';
import { SlotPicker } from './slot-picker';

type Step = 'service' | 'staff' | 'time' | 'details' | 'verify' | 'done' | 'waitlisted';
const STEPS: readonly Step[] = ['service', 'staff', 'time', 'details', 'verify'];
// The step bar's names, by the steps above.
const STEP_NAMES = ['Service', 'Who', 'Time', 'Your details', 'Your code'] as const;

/** What to say about a wrong or expired code. */
function codeProblemText(problem: 'wrong_code' | 'expired', body: unknown): string {
  if (problem === 'expired') return 'That code has expired. Send a new one.';
  const wrong = WrongCodeSchema.safeParse(body);
  const left = wrong.success ? wrong.data.attemptsLeft : null;
  return left === null
    ? 'That code isn’t right.'
    : `That code isn’t right. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.`;
}

/** The nearest free times of a 409 `slot_unavailable` answer, or `null`. */
function alternativesOf(result: CallResult<unknown>): AvailableSlot[] | null {
  if (result.ok || result.status !== 409) return null;
  const refusal = SlotUnavailableSchema.safeParse(result.body);
  return refusal.success ? refusal.data.alternatives : null;
}

interface StaffChoice {
  /** `null`: anyone. */
  id: string | null;
  name: string;
  note: string | null;
}

/** "Anyone available" first, then each staff member who offers the service. */
function staffChoices(staff: readonly { id: string; displayName: string }[]): StaffChoice[] {
  return [
    { id: null, name: 'Anyone available', note: 'Shows the most times' },
    ...staff.map((member) => ({ id: member.id, name: member.displayName, note: null })),
  ];
}

/** A choice that moves the booking on: a hairline row, the whole row one button. */
function ChoiceRow({
  title,
  meta,
  trailing,
  onSelect,
}: {
  title: string;
  meta?: string | null | undefined;
  trailing?: string | null | undefined;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cx(
          'flex min-h-14 w-full items-center gap-3 rounded-md bg-transparent px-4 py-3 text-left font-normal text-ink hover:bg-surface-2',
          FOCUS_RING,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="type-body font-semibold">{title}</span>
          {meta === null || meta === undefined ? null : (
            <span className="type-caption text-ink-2">{meta}</span>
          )}
        </span>
        {trailing === null || trailing === undefined ? null : (
          <span className="shrink-0 type-body font-semibold tabular-nums">{trailing}</span>
        )}
        <Icon name="right" className="text-ink-3" />
      </button>
    </li>
  );
}

/** The booking's facts once it's done: a quiet panel with a hairline table. */
function Summary({ rows }: { rows: readonly { label: string; value: ReactNode }[] }) {
  return <DetailTable rows={rows} className="rounded-lg bg-surface px-4" />;
}

/**
 * The client's booking (W8, AC-W8-2): service → staff member or anyone → time → details →
 * the code emailed to them → booked, with the link to reschedule or cancel. Nothing is booked
 * before the code; if the time goes meanwhile, the same code books one of the nearest times.
 * A day with nothing free offers "Join the waitlist" (S38a): the same details and code, and
 * the client then waits for that day.
 */
export function BookingFlow({ business, now }: { business: PublicBusiness; now: number }) {
  const { slug, timeZone } = business;
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState<string | null>(null);
  // `null`: anyone.
  const [staffMemberId, setStaffMemberId] = useState<string | null>(null);
  const [slot, setSlot] = useState<AvailableSlot | null>(null);
  const [details, setDetails] = useState<ClientDetails | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [alternatives, setAlternatives] = useState<AvailableSlot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof ClientDetails, string>>>({});
  const [busy, setBusy] = useState(false);
  const [booked, setBooked] = useState<BookingConfirmResponse | null>(null);
  // "Join the waitlist" (S38a): the day with nothing free; the steps after it join instead.
  const [waitlistDay, setWaitlistDay] = useState<{ date: string; label: string } | null>(null);
  const [waitlisted, setWaitlisted] = useState<WaitlistConfirmResponse | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formId = useId();

  const service = serviceOf(business, serviceId);
  const staffNames = useMemo(
    () => new Map<string, string>(business.staff.map((member) => [member.id, member.displayName])),
    [business.staff],
  );

  function go(next: Step): void {
    setStep(next);
    setError(null);
    // Move focus to the new step's heading, as a new page would.
    requestAnimationFrame(() => headingRef.current?.focus());
  }

  async function sendCode(chosen: AvailableSlot | null, who: ClientDetails): Promise<void> {
    if (serviceId === null) return;
    setBusy(true);
    setError(null);
    const answer =
      waitlistDay !== null
        ? await sendJson('POST', publicApiPath(slug, '/waitlist-requests'), {
            serviceId,
            staffMemberId,
            date: waitlistDay.date,
            ...who,
          })
        : chosen === null
          ? null
          : await sendJson('POST', publicApiPath(slug, '/booking-requests'), {
              serviceId,
              staffMemberId,
              startsAt: chosen.startsAt,
              ...who,
            });
    if (answer === null) {
      setBusy(false);
      return;
    }
    setBusy(false);
    if (answer.ok) {
      const parsed = BookingRequestResponseSchema.safeParse(answer.data);
      if (!parsed.success) {
        setError('Something went wrong. Try again.');
        return;
      }
      setRequestId(parsed.data.requestId);
      setCode('');
      setAlternatives(null);
      go('verify');
      return;
    }
    const others = alternativesOf(answer);
    if (others !== null) {
      setAlternatives(others);
      go('time');
      setError('Someone just took that time. Pick another one.');
      return;
    }
    setError(answer.message);
  }

  async function onDetails(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const checked = checkDetails({
      name: formText(form, 'name'),
      email: formText(form, 'email'),
      phone: formText(form, 'phone'),
    });
    if (!checked.ok) {
      setFieldErrors(checked.errors);
      return;
    }
    setFieldErrors({});
    setDetails(checked.details);
    await sendCode(slot, checked.details);
  }

  async function joinWaitlist(): Promise<void> {
    if (requestId === null) return;
    setBusy(true);
    setError(null);
    const answer = await sendJson(
      'POST',
      publicApiPath(slug, `/waitlist-requests/${requestId}/confirm`),
      { code: code.trim() },
    );
    setBusy(false);
    if (answer.ok) {
      const parsed = WaitlistConfirmResponseSchema.safeParse(answer.data);
      if (!parsed.success) {
        setError('Something went wrong. Try again.');
        return;
      }
      setWaitlisted(parsed.data);
      go('waitlisted');
      return;
    }
    const problem = confirmProblem(answer.status, answer.body);
    if (problem === 'used') {
      setError('You’re already on the waitlist. Check your email for the details.');
      return;
    }
    if (problem === 'wrong_code' || problem === 'expired') {
      setError(codeProblemText(problem, answer.body));
      return;
    }
    setError(answer.message);
  }

  async function confirm(startsAt?: string): Promise<void> {
    if (requestId === null) return;
    setBusy(true);
    setError(null);
    const answer = await sendJson(
      'POST',
      publicApiPath(slug, `/booking-requests/${requestId}/confirm`),
      { code: code.trim(), ...(startsAt !== undefined && { startsAt }) },
    );
    setBusy(false);
    if (answer.ok) {
      const parsed = BookingConfirmResponseSchema.safeParse(answer.data);
      if (!parsed.success) {
        setError('Something went wrong. Try again.');
        return;
      }
      setBooked(parsed.data);
      go('done');
      return;
    }
    const problem = confirmProblem(answer.status, answer.body);
    switch (problem) {
      case 'wrong_code':
      case 'expired':
        setError(codeProblemText(problem, answer.body));
        return;
      case 'used':
        setError('This booking is already confirmed. Check your email for the details.');
        return;
      case 'taken':
        setAlternatives(alternativesOf(answer) ?? []);
        return;
      case 'other':
        setError(answer.message);
    }
  }

  async function onVerify(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setError('Enter the 6 digits from the email.');
      return;
    }
    if (waitlistDay !== null) await joinWaitlist();
    else await confirm();
  }

  const index = STEPS.indexOf(step);
  const picked: { step: Step; label: string }[] = [];
  if (service !== undefined && index > 0) {
    const price = priceLabel(service);
    picked.push({
      step: 'service',
      label: price === null ? service.name : `${service.name} · ${price}`,
    });
  }
  if (index > 1) {
    picked.push({
      step: 'staff',
      label: staffMemberId === null ? 'Anyone available' : (staffNames.get(staffMemberId) ?? ''),
    });
  }
  // The chosen time, or the waitlist's day: in the choices and the sticky bar alike.
  const when =
    waitlistDay !== null
      ? `Waitlist: ${waitlistDay.label}`
      : slot === null
        ? null
        : dateTimeLabel(timeZone, slot.startsAt);
  if (when !== null && index > 2) picked.push({ step: 'time', label: when });

  const heading = (text: string) => (
    <h1 ref={headingRef} tabIndex={-1} className="m-0 type-display text-ink outline-none">
      {text}
    </h1>
  );
  const firstName = details === null ? '' : (details.name.split(/\s+/)[0] ?? details.name);
  // What the sticky bar sums up: the service and, once picked, the time.
  const barSummary = (
    <>
      <span className="block truncate">{service?.name}</span>
      <span className="block truncate type-caption text-ink-2">{when}</span>
    </>
  );

  return (
    <div className="flex flex-col gap-5">
      {index >= 0 ? <StepBar steps={STEP_NAMES} current={index} /> : null}
      {picked.length > 0 && step !== 'done' ? (
        <List label="Your choices" className="rounded-lg bg-surface px-4">
          {picked.map((choice) => (
            <li key={choice.step} className="flex min-h-12 items-center gap-3 py-1">
              <span className="min-w-0 flex-1 truncate type-label text-ink">{choice.label}</span>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Change: ${choice.label}`}
                onClick={() => {
                  setAlternatives(null);
                  go(choice.step);
                }}
              >
                Change
              </Button>
            </li>
          ))}
        </List>
      ) : null}

      {step === 'service' ? (
        <>
          {heading('Book a visit')}
          {business.services.length === 0 ? (
            <p className="m-0 rounded-lg bg-surface-2 px-5 py-6 type-body text-ink">
              There’s nothing to book online yet. Call or message {business.name} to book.
            </p>
          ) : (
            servicesByCategory(business.services).map((group) => (
              <section key={group.category ?? ''} className="flex flex-col gap-2">
                {group.category === null ? null : (
                  <h2 className="m-0 type-label text-ink-2">{group.category}</h2>
                )}
                <List className="rounded-lg bg-surface">
                  {group.services.map((item) => (
                    <ChoiceRow
                      key={item.id}
                      title={item.name}
                      meta={durationLabel(item.durationMinutes)}
                      trailing={priceLabel(item)}
                      onSelect={() => {
                        setServiceId(item.id);
                        setSlot(null);
                        go('staff');
                      }}
                    />
                  ))}
                </List>
              </section>
            ))
          )}
        </>
      ) : null}

      {step === 'staff' && serviceId !== null ? (
        <>
          {heading('Who would you like?')}
          <List className="rounded-lg bg-surface">
            {staffChoices(staffFor(business, serviceId)).map((choice) => (
              <ChoiceRow
                key={choice.id ?? 'anyone'}
                title={choice.name}
                meta={choice.note}
                onSelect={() => {
                  setStaffMemberId(choice.id);
                  setSlot(null);
                  go('time');
                }}
              />
            ))}
          </List>
        </>
      ) : null}

      {step === 'time' && serviceId !== null ? (
        <>
          {heading('Pick a time')}
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          {alternatives !== null && alternatives.length > 0 ? (
            <div className="flex flex-wrap gap-2" data-testid="alternatives">
              {alternatives.map((other) => (
                <button
                  key={other.startsAt}
                  type="button"
                  className={chipStyle(false)}
                  onClick={() => {
                    setSlot(other);
                    setAlternatives(null);
                    go('details');
                  }}
                >
                  {dateTimeLabel(timeZone, other.startsAt)}
                </button>
              ))}
            </div>
          ) : null}
          <SlotPicker
            slug={slug}
            timeZone={timeZone}
            now={now}
            serviceId={serviceId}
            staffMemberId={staffMemberId}
            staffNames={staffNames}
            onPick={(chosen) => {
              setSlot(chosen);
              setWaitlistDay(null);
              setAlternatives(null);
              go('details');
            }}
            onWaitlist={(day) => {
              setWaitlistDay(day);
              setSlot(null);
              setAlternatives(null);
              go('details');
            }}
          />
        </>
      ) : null}

      {step === 'details' ? (
        <>
          {heading(waitlistDay === null ? 'Your details' : 'Join the waitlist')}
          <p className="m-0 type-body text-ink-2">
            {waitlistDay === null
              ? 'We’ll email you a code to confirm it’s you.'
              : `We’ll email you a code to confirm it’s you. If a time opens up on ${waitlistDay.label}, we email you a link to claim it.`}
          </p>
          <form
            id={formId}
            className="flex flex-col gap-4"
            noValidate
            onSubmit={(event) => void onDetails(event)}
          >
            <Input
              label="Full name"
              name="name"
              autoComplete="name"
              defaultValue={details?.name ?? ''}
              error={fieldErrors.name}
            />
            <Input
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              defaultValue={details?.email ?? ''}
              error={fieldErrors.email}
            />
            <Input
              label="Phone (optional)"
              name="phone"
              type="tel"
              autoComplete="tel"
              defaultValue={details?.phone ?? ''}
              error={fieldErrors.phone}
            />
            <p className="m-0 type-caption text-ink-2">
              We only use your details for this appointment and messages about it.
            </p>
            {error === null ? null : <Notice tone="error">{error}</Notice>}
          </form>
          <StickyActionBar
            summary={barSummary}
            primary={
              <Button type="submit" form={formId} busy={busy}>
                {busy ? 'Sending…' : 'Send my code'}
              </Button>
            }
          />
        </>
      ) : null}

      {step === 'verify' && details !== null ? (
        <>
          {heading('Check your email')}
          <p className="m-0 type-body text-ink-2">
            We sent a 6-digit code to <b className="text-ink">{details.email}</b>.
          </p>
          {alternatives === null ? (
            <>
              <form
                id={formId}
                className="flex flex-col gap-4"
                noValidate
                onSubmit={(event) => void onVerify(event)}
              >
                <Input
                  label="Code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, ''));
                  }}
                  className="text-center type-title tracking-[0.4em] tabular-nums"
                />
                {error === null ? null : <Notice tone="error">{error}</Notice>}
                <Button
                  variant="quiet"
                  size="sm"
                  disabled={busy}
                  className="self-start"
                  onClick={() => {
                    void sendCode(slot, details);
                  }}
                >
                  Send a new code
                </Button>
              </form>
              <StickyActionBar
                summary={barSummary}
                primary={
                  <Button type="submit" form={formId} busy={busy}>
                    {busy
                      ? 'Confirming…'
                      : waitlistDay === null
                        ? 'Confirm booking'
                        : 'Join the waitlist'}
                  </Button>
                }
              />
            </>
          ) : (
            <section
              aria-label="That time was taken"
              className="flex flex-col gap-3 rounded-lg bg-warn-soft p-5"
            >
              <p className="m-0 type-body font-semibold text-warn" role="alert">
                {slot === null ? 'That time' : timeLabel(timeZone, slot.startsAt)} was booked a
                moment before you confirmed.
                {alternatives.length === 0
                  ? ' Nothing is free nearby; pick another time.'
                  : ' Your details are saved. Pick one of the nearest times and you’re done:'}
              </p>
              <div className="flex flex-wrap gap-2" data-testid="alternatives">
                {alternatives.map((other) => (
                  <button
                    key={other.startsAt}
                    type="button"
                    disabled={busy}
                    className={chipStyle(false)}
                    onClick={() => {
                      setSlot(other);
                      void confirm(other.startsAt);
                    }}
                  >
                    {dateTimeLabel(timeZone, other.startsAt)}
                  </button>
                ))}
              </div>
              {error === null ? null : <Notice tone="error">{error}</Notice>}
              <Button
                variant="secondary"
                size="sm"
                className="self-start"
                onClick={() => {
                  setAlternatives(null);
                  go('time');
                }}
              >
                See all times
              </Button>
            </section>
          )}
        </>
      ) : null}

      {step === 'waitlisted' && waitlisted !== null && details !== null ? (
        <>
          <Done />
          {heading(`You’re on the waitlist, ${firstName}`)}
          <p className="m-0 type-body text-ink-2">
            If a time opens up, we email <b className="text-ink">{details.email}</b> a link to claim
            it. The first to claim it gets it.
          </p>
          <Summary
            rows={[
              { label: 'Service', value: waitlisted.entry.service.name },
              {
                label: 'With',
                value: waitlisted.entry.staff?.displayName ?? 'Anyone available',
              },
              { label: 'Day', value: waitlistDay?.label ?? waitlisted.entry.date },
            ]}
          />
        </>
      ) : null}

      {step === 'done' && booked !== null && details !== null ? (
        <>
          <Done />
          {heading(`You’re booked, ${firstName}`)}
          <p className="m-0 type-body text-ink-2">
            We emailed a confirmation to <b className="text-ink">{details.email}</b>, with a link to
            reschedule or cancel.
          </p>
          <Summary
            rows={[
              { label: 'Service', value: booked.booking.service.name },
              { label: 'With', value: booked.booking.staff.displayName },
              {
                label: 'When',
                value: (
                  <span className="tabular-nums">
                    {dateTimeLabel(timeZone, booked.booking.startsAt)}
                  </span>
                ),
              },
            ]}
          />
          <a
            href={managePath(slug, booked.manageToken)}
            className={cx(buttonStyle({ variant: 'secondary' }), 'self-start')}
          >
            Reschedule or cancel
          </a>
        </>
      ) : null}
    </div>
  );
}

/** The tick above a finished booking or waitlist entry. */
function Done() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-12 items-center justify-center rounded-pill bg-ok-soft text-ok"
    >
      <Icon name="check" />
    </span>
  );
}
