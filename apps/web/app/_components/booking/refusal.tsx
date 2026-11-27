'use client';

import {
  normalizePhone,
  SlotUnavailableSchema,
  SMS_WAITLIST_CONSENT_WORDING,
  SmsPhoneSchema,
  WaitlistEntrySchema,
  WaitlistTimesFreeSchema,
  type AvailableSlot,
  type WaitlistEntryInput,
} from '@pepper/contracts';
import { Button, Checkbox, Input, TimeChip } from '@pepper/ui';
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { dateTimeLabel, suggestedWindow } from '../../../lib/booking';
import { sendJson, type CallResult } from '../../../lib/client-api';
import { formText } from '../../../lib/form';
import { Notice } from '../form-parts';

/** The nearest free times of a 409 `slot_unavailable` answer, or `null` for any other one. */
export function alternativesOf(result: CallResult<unknown>): AvailableSlot[] | null {
  if (result.ok || result.status !== 409) return null;
  const refusal = SlotUnavailableSchema.safeParse(result.body);
  return refusal.success ? refusal.data.alternatives : null;
}

/**
 * A refused time (AC-W2-1): why, the nearest free times to pick instead, and, for a new
 * booking, a waitlist entry for when the wanted time frees up.
 */
export function Refusal({
  timeZone,
  alternatives,
  onPick,
  busy,
  waitlist,
}: {
  timeZone: string;
  alternatives: AvailableSlot[];
  onPick: (slot: AvailableSlot) => void;
  busy: boolean;
  /** For a new booking: the entry to add, without its windows, and the wanted start. */
  waitlist?:
    | {
        entry: Omit<WaitlistEntryInput, 'windows' | 'smsConsent'>;
        phone?: string | null;
        wanted: string;
        minutes: number;
        onAdded: () => void;
      }
    | undefined;
}) {
  const box = useRef<HTMLElement>(null);
  // The sheet's Book or Move sits in its footer; the answer shows where the eye can find it.
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <section
      ref={box}
      aria-label="That time is taken"
      className="grid gap-3 rounded-md bg-warn-soft p-4"
    >
      <p className="m-0 type-body font-semibold text-ink" role="alert">
        That time can’t be booked.
        {alternatives.length === 0
          ? ' There’s nothing free nearby.'
          : ' These are the nearest free times:'}
      </p>
      {alternatives.length === 0 ? null : (
        <div className="flex flex-wrap gap-2" data-testid="alternatives">
          {alternatives.map((slot) => (
            <TimeChip
              key={slot.startsAt}
              time={dateTimeLabel(timeZone, slot.startsAt)}
              disabled={busy}
              onSelect={() => {
                onPick(slot);
              }}
            />
          ))}
        </div>
      )}
      {waitlist === undefined ? null : <WaitlistOffer timeZone={timeZone} {...waitlist} />}
    </section>
  );
}

function WaitlistOffer({
  timeZone,
  entry,
  phone,
  wanted,
  minutes,
  onAdded,
}: {
  timeZone: string;
  entry: Omit<WaitlistEntryInput, 'windows' | 'smsConsent'>;
  /** The client's number on file, for "They agreed to texts about openings" (S79). */
  phone?: string | null;
  wanted: string;
  /** The service's length: the suggested window is exactly the wanted appointment. */
  minutes: number;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [texts, setTexts] = useState(false);
  const [phoneError, setPhoneError] = useState<string | undefined>(undefined);
  const suggested = suggestedWindow(timeZone, wanted, minutes);

  async function add(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    // What the client told the team (S79, AC-X-223): a number Pepper can text, or nothing sent.
    let smsConsent = null;
    if (texts) {
      const number = SmsPhoneSchema.safeParse(normalizePhone(formText(form, 'textsPhone')));
      if (!number.success) {
        setPhoneError('Use a US or Canadian mobile number, or untick the box.');
        form.querySelector<HTMLElement>('[name="textsPhone"]')?.focus();
        return;
      }
      smsConsent = { phone: number.data, wordingVersion: SMS_WAITLIST_CONSENT_WORDING };
    }
    setPhoneError(undefined);
    setBusy(true);
    const answer = await sendJson('POST', '/v1/waitlist', {
      ...entry,
      smsConsent,
      windows: [
        {
          date: formText(form, 'date'),
          start: formText(form, 'start'),
          end: formText(form, 'end'),
        },
      ],
    });
    setBusy(false);
    if (answer.ok && WaitlistEntrySchema.safeParse(answer.data).success) {
      onAdded();
      return;
    }
    if (answer.ok) {
      setError('Something went wrong. Try again.');
      return;
    }
    // A window with a free time is refused with those times (S44): name them.
    const free = WaitlistTimesFreeSchema.safeParse(answer.body);
    setError(
      free.success && free.data.alternatives.length > 0
        ? `That isn’t full: ${free.data.alternatives
            .map((slot) => dateTimeLabel(timeZone, slot.startsAt))
            .join(
              ', ',
            )} ${free.data.alternatives.length === 1 ? 'is' : 'are'} free. Book one instead.`
        : answer.message,
    );
  }

  if (!open) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="justify-self-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        Add to the waitlist
      </Button>
    );
  }
  return (
    <form className="grid gap-2" onSubmit={(event) => void add(event)}>
      <p className="m-0 type-body text-ink">I’ll keep them on the waitlist for this time:</p>
      <Input label="Day" type="date" name="date" required defaultValue={suggested.date} />
      <div className="grid grid-cols-2 gap-2">
        <Input label="From" type="time" name="start" required defaultValue={suggested.start} />
        <Input
          label="Until"
          type="time"
          name="end"
          required
          defaultValue={suggested.end === '24:00' ? '23:59' : suggested.end}
        />
      </div>
      <Checkbox
        name="texts"
        label="They agreed to texts about openings"
        hint="Only if they said yes. I text them when a time opens up, and once now with how to stop."
        checked={texts}
        onChange={(event) => {
          setTexts(event.target.checked);
        }}
      />
      {texts ? (
        <Input
          label="Their mobile"
          type="tel"
          name="textsPhone"
          autoComplete="off"
          defaultValue={phone ?? ''}
          error={phoneError}
        />
      ) : null}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <Button type="submit" size="sm" busy={busy} className="justify-self-start">
        Add to the waitlist
      </Button>
    </form>
  );
}
