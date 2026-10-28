'use client';

import {
  SlotUnavailableSchema,
  WaitlistEntrySchema,
  type AvailableSlot,
  type WaitlistEntryInput,
} from '@pepper/contracts';
import { Button, Input, TimeChip } from '@pepper/ui';
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
  waitlist?: { entry: Omit<WaitlistEntryInput, 'windows'>; wanted: string; onAdded: () => void };
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
  wanted,
  onAdded,
}: {
  timeZone: string;
  entry: Omit<WaitlistEntryInput, 'windows'>;
  wanted: string;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const suggested = suggestedWindow(timeZone, wanted);

  async function add(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy(true);
    const answer = await sendJson('POST', '/v1/waitlist', {
      ...entry,
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
    setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
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
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <Button type="submit" size="sm" busy={busy} className="justify-self-start">
        Add to the waitlist
      </Button>
    </form>
  );
}
