'use client';

import {
  BookingSchema,
  type AvailableSlot,
  type BookingChange,
  type BookingStatus,
} from '@pepper/contracts';
import { buttonClass, cx } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  bookableStaff,
  bookingActions,
  dateTimeLabel,
  localParts,
  STATUS_LABELS,
  timeLabel,
  type BookingSetup,
} from '../../../lib/booking';
import { timeRange } from '../../../lib/calendar';
import { sendJson } from '../../../lib/client-api';
import { NotifyClient } from './notify-client';
import { alternativesOf, Refusal } from './refusal';
import { Field, Notice, Sheet } from './sheet';
import { TimePicker } from './time-picker';

/** What the booking sheet shows and changes; the calendar has it for every booking it draws. */
export interface BookingSummary {
  id: string;
  client: string;
  service: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  overridden: boolean;
}

/**
 * A booking on the calendar, as a button that opens its sheet: the details, done or no-show
 * once it has started, move and cancel. Every change goes through `PATCH /v1/bookings/:id`,
 * which checks it again (staff: their own bookings; done and no-show final for them). A move or
 * cancellation emails the client unless the team unticks it (ADR-0025).
 */
export function BookingSheet({
  booking,
  setup,
  className,
  style,
  children,
}: {
  booking: BookingSummary;
  setup: BookingSetup;
  className: string;
  style: CSSProperties;
  /** The block's content on the calendar. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(0);
  const { timeZone } = setup;
  const staffName =
    setup.staff.find((member) => member.id === booking.staffMemberId)?.displayName ?? 'Staff';
  return (
    <Sheet
      title={booking.client}
      description={`${booking.service} with ${staffName}`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKey((k) => k + 1);
      }}
      trigger={
        <button
          type="button"
          data-testid="booking-block"
          aria-label={`${timeRange(timeZone, booking.startsAt, booking.endsAt)}, ${booking.service} with ${booking.client}`}
          className={cx(className, 'cursor-pointer text-left font-normal')}
          style={style}
        >
          {children}
        </button>
      }
    >
      <BookingDetails
        key={key}
        booking={booking}
        setup={setup}
        onDone={() => {
          setOpen(false);
        }}
      />
    </Sheet>
  );
}

type View = 'details' | 'move' | 'cancel';

function BookingDetails({
  booking,
  setup,
  onDone,
}: {
  booking: BookingSummary;
  setup: BookingSetup;
  onDone: () => void;
}) {
  const router = useRouter();
  const { timeZone, abilities } = setup;
  const [view, setView] = useState<View>('details');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<AvailableSlot[] | null>(null);
  const [notifyClient, setNotifyClient] = useState(true);
  // The sheet's clock: the api checks the real one (done and no-show only once started).
  const [now] = useState(() => Date.now());
  const actions = bookingActions(booking, now, abilities.correctsOutcomes);

  async function change(body: BookingChange): Promise<void> {
    setBusy(true);
    const answer = await sendJson('PATCH', `/v1/bookings/${encodeURIComponent(booking.id)}`, body);
    setBusy(false);
    if (answer.ok && BookingSchema.safeParse(answer.data).success) {
      onDone();
      router.refresh();
      return;
    }
    const alternatives = alternativesOf(answer);
    setRefused(alternatives);
    setError(alternatives === null ? (answer.ok ? 'Something went wrong.' : answer.message) : null);
  }

  const summary = (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
      <dt className="text-ink-2">When</dt>
      <dd className="m-0 font-semibold">
        {dateTimeLabel(timeZone, booking.startsAt)} – {timeLabel(timeZone, booking.endsAt)}
      </dd>
      <dt className="text-ink-2">Status</dt>
      <dd className="m-0 font-semibold" data-testid="booking-status">
        {STATUS_LABELS[booking.status]}
      </dd>
      {booking.overridden ? (
        <>
          <dt className="text-ink-2">Note</dt>
          <dd className="m-0 text-wait">Booked outside the usual hours</dd>
        </>
      ) : null}
    </dl>
  );

  if (view === 'cancel') {
    return (
      <div className="grid gap-4">
        {summary}
        <p className="m-0 font-semibold">Cancel this booking? The time becomes free again.</p>
        <NotifyClient checked={notifyClient} onChange={setNotifyClient}>
          Email the client that it is cancelled
        </NotifyClient>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            className={buttonClass({ variant: 'secondary', className: 'text-danger' })}
            onClick={() => void change({ status: 'cancelled', notifyClient })}
          >
            Cancel booking
          </button>
          <button
            type="button"
            className={buttonClass({ variant: 'secondary' })}
            onClick={() => {
              setView('details');
              setError(null);
            }}
          >
            Keep it
          </button>
        </div>
      </div>
    );
  }

  if (view === 'move') {
    return (
      <MoveBooking
        booking={booking}
        setup={setup}
        busy={busy}
        error={error}
        refused={refused}
        notifyClient={notifyClient}
        onNotifyClientChange={setNotifyClient}
        onMove={(startsAt, staffMemberId) => void change({ startsAt, staffMemberId, notifyClient })}
        onBack={() => {
          setView('details');
          setError(null);
          setRefused(null);
        }}
      />
    );
  }

  const none = !actions.complete && !actions.noShow && !actions.move && !actions.cancel;
  return (
    <div className="grid gap-4">
      {summary}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {none ? (
        <p className="m-0 text-ink-2">
          {booking.status === 'cancelled' || abilities.correctsOutcomes
            ? 'Nothing more to change here.'
            : 'This is recorded. An owner or manager can correct it if needed.'}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.complete ? (
            <button
              type="button"
              disabled={busy}
              className={buttonClass()}
              onClick={() => void change({ status: 'completed' })}
            >
              Mark done
            </button>
          ) : null}
          {actions.noShow ? (
            <button
              type="button"
              disabled={busy}
              className={buttonClass({ variant: 'secondary' })}
              onClick={() => void change({ status: 'no_show' })}
            >
              No-show
            </button>
          ) : null}
          {actions.move ? (
            <button
              type="button"
              className={buttonClass({ variant: 'secondary' })}
              onClick={() => {
                setView('move');
                setError(null);
              }}
            >
              Move
            </button>
          ) : null}
          {actions.cancel ? (
            <button
              type="button"
              className={buttonClass({ variant: 'quiet', className: 'text-danger' })}
              onClick={() => {
                setView('cancel');
                setError(null);
              }}
            >
              Cancel booking
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function MoveBooking({
  booking,
  setup,
  busy,
  error,
  refused,
  notifyClient,
  onNotifyClientChange,
  onMove,
  onBack,
}: {
  booking: BookingSummary;
  setup: BookingSetup;
  busy: boolean;
  error: string | null;
  refused: AvailableSlot[] | null;
  notifyClient: boolean;
  onNotifyClientChange: (checked: boolean) => void;
  onMove: (startsAt: string, staffMemberId: string) => void;
  onBack: () => void;
}) {
  const { timeZone, abilities } = setup;
  const offering = bookableStaff(setup.staff, {
    userId: setup.userId,
    ownOnly: abilities.ownStaffOnly,
    serviceId: booking.serviceId,
  });
  // The booking's own staff member stays a choice, even if they no longer offer the service.
  const choices = offering.some((member) => member.id === booking.staffMemberId)
    ? offering
    : [...setup.staff.filter((member) => member.id === booking.staffMemberId), ...offering];
  const [staffMemberId, setStaffMemberId] = useState(booking.staffMemberId);
  const [date, setDate] = useState(() => localParts(timeZone, booking.startsAt).date);
  const [startsAt, setStartsAt] = useState<string | null>(null);

  return (
    <div className="grid gap-4">
      <p className="m-0 text-ink-2">
        Now {dateTimeLabel(timeZone, booking.startsAt)}. Pick the new time.
      </p>
      {choices.length > 1 ? (
        <Field label="With">
          <select
            name="staff"
            value={staffMemberId}
            onChange={(event) => {
              setStaffMemberId(event.target.value);
              setStartsAt(null);
            }}
          >
            {choices.map((member) => (
              <option key={member.id} value={member.id}>
                {member.displayName}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <TimePicker
        timeZone={timeZone}
        serviceId={booking.serviceId}
        staffMemberId={staffMemberId}
        date={date}
        onDateChange={setDate}
        value={startsAt}
        onChange={setStartsAt}
      />
      <NotifyClient checked={notifyClient} onChange={onNotifyClientChange}>
        Email the client the new time
      </NotifyClient>
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      {refused === null ? null : (
        <Refusal
          timeZone={timeZone}
          alternatives={refused}
          busy={busy}
          onPick={(slot) => {
            onMove(slot.startsAt, slot.staffMemberId);
          }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={startsAt === null || busy}
          className={buttonClass()}
          onClick={() => {
            if (startsAt !== null) onMove(startsAt, staffMemberId);
          }}
        >
          {busy ? 'Moving…' : 'Move here'}
        </button>
        <button type="button" className={buttonClass({ variant: 'secondary' })} onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
