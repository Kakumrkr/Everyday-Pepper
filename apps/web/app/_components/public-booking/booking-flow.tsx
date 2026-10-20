'use client';

import {
  BookingConfirmResponseSchema,
  BookingRequestResponseSchema,
  SlotUnavailableSchema,
  WrongCodeSchema,
  type AvailableSlot,
  type BookingConfirmResponse,
  type PublicBusiness,
} from '@pepper/contracts';
import { buttonClass, chipClass, Icon } from '@pepper/ui';
import { useMemo, useRef, useState, type SubmitEvent } from 'react';
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
import { Field, Notice } from '../booking/sheet';
import { SlotPicker } from './slot-picker';

type Step = 'service' | 'staff' | 'time' | 'details' | 'verify' | 'done';
const STEPS: readonly Step[] = ['service', 'staff', 'time', 'details', 'verify'];

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

/**
 * The client's booking (W8, AC-W8-2): service → staff member or anyone → time → details →
 * the code emailed to them → booked, with the link to reschedule or cancel. Nothing is booked
 * before the code; if the time goes meanwhile, the same code books one of the nearest times.
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
  const headingRef = useRef<HTMLHeadingElement>(null);

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

  async function sendCode(chosen: AvailableSlot, who: ClientDetails): Promise<void> {
    if (serviceId === null) return;
    setBusy(true);
    setError(null);
    const answer = await sendJson('POST', publicApiPath(slug, '/booking-requests'), {
      serviceId,
      staffMemberId,
      startsAt: chosen.startsAt,
      ...who,
    });
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
    if (slot !== null) await sendCode(slot, checked.details);
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
    switch (confirmProblem(answer.status, answer.body)) {
      case 'wrong_code': {
        const wrong = WrongCodeSchema.safeParse(answer.body);
        const left = wrong.success ? wrong.data.attemptsLeft : null;
        setError(
          left === null
            ? 'That code isn’t right.'
            : `That code isn’t right. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.`,
        );
        return;
      }
      case 'expired':
        setError('That code has expired. Send a new one.');
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
    await confirm();
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
  if (slot !== null && index > 2) {
    picked.push({ step: 'time', label: dateTimeLabel(timeZone, slot.startsAt) });
  }

  const heading = (text: string) => (
    <h1 ref={headingRef} tabIndex={-1} className="m-0 font-display text-2xl font-bold outline-none">
      {text}
    </h1>
  );

  return (
    <div className="grid gap-4">
      {index >= 0 ? (
        <div aria-hidden="true" className="flex gap-1.5">
          {STEPS.map((name, i) => (
            <i
              key={name}
              className={`h-1 flex-1 rounded-full ${i <= index ? 'bg-brand' : 'bg-line'}`}
            />
          ))}
        </div>
      ) : null}
      {picked.length > 0 && step !== 'done' ? (
        <div aria-label="Your choices" className="flex flex-wrap gap-2">
          {picked.map((choice) => (
            <button
              key={choice.step}
              type="button"
              className={chipClass()}
              aria-label={`Change: ${choice.label}`}
              onClick={() => {
                setAlternatives(null);
                go(choice.step);
              }}
            >
              {choice.label} · <span className="text-brand">Change</span>
            </button>
          ))}
        </div>
      ) : null}

      {step === 'service' ? (
        <>
          {heading('Book a visit')}
          {business.services.length === 0 ? (
            <p className="m-0 text-ink-2">
              There’s nothing to book online yet. Contact the business.
            </p>
          ) : (
            servicesByCategory(business.services).map((group) => (
              <section key={group.category ?? ''} className="grid gap-2">
                {group.category === null ? null : (
                  <h2 className="m-0 text-sm font-semibold text-ink-2">{group.category}</h2>
                )}
                {group.services.map((item) => {
                  const price = priceLabel(item);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left text-ink hover:bg-surface-2"
                      onClick={() => {
                        setServiceId(item.id);
                        setSlot(null);
                        go('staff');
                      }}
                    >
                      <span className="grid">
                        <b>{item.name}</b>
                        <span className="text-sm text-ink-2">
                          {durationLabel(item.durationMinutes)}
                        </span>
                      </span>
                      {price === null ? null : <span className="font-semibold">{price}</span>}
                    </button>
                  );
                })}
              </section>
            ))
          )}
        </>
      ) : null}

      {step === 'staff' && serviceId !== null ? (
        <>
          {heading('Who would you like?')}
          <div className="grid gap-2">
            {staffChoices(staffFor(business, serviceId)).map((choice) => (
              <button
                key={choice.id ?? 'anyone'}
                type="button"
                className="flex min-h-11 items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-left text-ink hover:bg-surface-2"
                onClick={() => {
                  setStaffMemberId(choice.id);
                  setSlot(null);
                  go('time');
                }}
              >
                <span className="grid">
                  <b>{choice.name}</b>
                  {choice.note === null ? null : (
                    <span className="text-sm text-ink-2">{choice.note}</span>
                  )}
                </span>
                <Icon name="right" />
              </button>
            ))}
          </div>
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
                  className={chipClass()}
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
              setAlternatives(null);
              go('details');
            }}
          />
        </>
      ) : null}

      {step === 'details' ? (
        <>
          {heading('Your details')}
          <p className="m-0 text-ink-2">We’ll email you a code to confirm it’s you.</p>
          <form className="grid gap-3" noValidate onSubmit={(event) => void onDetails(event)}>
            <Field label="Full name">
              <input
                name="name"
                autoComplete="name"
                defaultValue={details?.name ?? ''}
                aria-invalid={fieldErrors.name !== undefined}
              />
            </Field>
            {fieldErrors.name === undefined ? null : (
              <Notice tone="error">{fieldErrors.name}</Notice>
            )}
            <Field label="Email">
              <input
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                defaultValue={details?.email ?? ''}
                aria-invalid={fieldErrors.email !== undefined}
              />
            </Field>
            {fieldErrors.email === undefined ? null : (
              <Notice tone="error">{fieldErrors.email}</Notice>
            )}
            <Field label="Phone (optional)">
              <input
                name="phone"
                type="tel"
                autoComplete="tel"
                defaultValue={details?.phone ?? ''}
                aria-invalid={fieldErrors.phone !== undefined}
              />
            </Field>
            {fieldErrors.phone === undefined ? null : (
              <Notice tone="error">{fieldErrors.phone}</Notice>
            )}
            <p className="m-0 text-sm text-ink-2">
              We only use your details for this appointment and messages about it.
            </p>
            {error === null ? null : <Notice tone="error">{error}</Notice>}
            <button type="submit" disabled={busy} className={buttonClass()}>
              {busy ? 'Sending…' : 'Send my code'}
            </button>
          </form>
        </>
      ) : null}

      {step === 'verify' && details !== null ? (
        <>
          {heading('Check your email')}
          <p className="m-0 text-ink-2">
            We sent a 6-digit code to <b className="text-ink">{details.email}</b>.
          </p>
          {alternatives === null ? (
            <form className="grid gap-3" noValidate onSubmit={(event) => void onVerify(event)}>
              <Field label="Code">
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, ''));
                  }}
                  className="text-center font-display text-2xl tracking-[0.4em]"
                />
              </Field>
              {error === null ? null : <Notice tone="error">{error}</Notice>}
              <button type="submit" disabled={busy} className={buttonClass()}>
                {busy ? 'Confirming…' : 'Confirm booking'}
              </button>
              <button
                type="button"
                disabled={busy}
                className={buttonClass({
                  variant: 'quiet',
                  size: 'sm',
                  className: 'justify-self-start',
                })}
                onClick={() => {
                  if (slot !== null) void sendCode(slot, details);
                }}
              >
                Send a new code
              </button>
            </form>
          ) : (
            <section
              aria-label="That time was taken"
              className="grid gap-3 rounded-md bg-wait-soft p-4"
            >
              <p className="m-0 font-semibold text-wait" role="alert">
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
                    className={chipClass()}
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
              <button
                type="button"
                className={buttonClass({
                  variant: 'secondary',
                  size: 'sm',
                  className: 'justify-self-start',
                })}
                onClick={() => {
                  setAlternatives(null);
                  go('time');
                }}
              >
                See all times
              </button>
            </section>
          )}
        </>
      ) : null}

      {step === 'done' && booked !== null && details !== null ? (
        <>
          <span
            aria-hidden="true"
            className="grid size-12 place-items-center rounded-full bg-ok-soft text-ok"
          >
            <Icon name="check" />
          </span>
          {heading(`You’re booked, ${details.name.split(/\s+/)[0] ?? details.name}`)}
          <p className="m-0 text-ink-2">
            We emailed a confirmation to <b className="text-ink">{details.email}</b>, with a link to
            reschedule or cancel.
          </p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-line bg-surface p-4">
            <dt className="text-ink-2">Service</dt>
            <dd className="m-0 font-semibold">{booked.booking.service.name}</dd>
            <dt className="text-ink-2">With</dt>
            <dd className="m-0 font-semibold">{booked.booking.staff.displayName}</dd>
            <dt className="text-ink-2">When</dt>
            <dd className="m-0 font-semibold">
              {dateTimeLabel(timeZone, booked.booking.startsAt)}
            </dd>
          </dl>
          <a
            href={managePath(slug, booked.manageToken)}
            className={buttonClass({ variant: 'secondary', className: 'justify-self-start' })}
          >
            Reschedule or cancel
          </a>
        </>
      ) : null}
    </div>
  );
}
