'use client';

import {
  BookingCalendarStateSchema,
  BookingDepositAnswerSchema,
  BookingSchema,
  BookingSeriesSchema,
  CancelFollowingResultSchema,
  type AvailableSlot,
  type BookingSeries,
  type BookingCalendarState,
  type BookingDeposit,
  type BookingChange,
  type BookingStatus,
} from '@pepper/contracts';
import { Button, cx, DetailTable, Segmented, Select, Sheet, SheetFooter } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import {
  bookableStaff,
  bookingActions,
  bookingBlockName,
  confirmedByText,
  confirmedLabel,
  dateTimeLabel,
  localParts,
  STATUS_LABELS,
  timeLabel,
  type BookingSetup,
} from '../../../lib/booking';
import { ROUTES } from '../../../lib/account';
import { laterVisits, seriesLine } from '../../../lib/booking-series';
import { fetchJson, sendJson } from '../../../lib/client-api';
import {
  bookingCalendarLine,
  bookingCalendarPath,
  keptOverGoogleLine,
} from '../../../lib/calendar-connect';
import { teamCancelDepositWords, teamDepositLine } from '../../../lib/deposits';
import { VisitNotes } from '../memory/visit-notes';
import { NotifyClient } from './notify-client';
import { alternativesOf, Refusal } from './refusal';
import { Notice } from '../form-parts';
import { TimePicker } from './time-picker';

/** What the booking sheet shows and changes; the calendar has it for every booking it draws. */
export interface BookingSummary {
  id: string;
  client: string;
  /** The client's profile to open; `null` for a deleted client (S50.2, AC-W1-36). */
  clientId: string | null;
  service: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: string;
  endsAt: string;
  status: BookingStatus;
  overridden: boolean;
  /** When the client replied C to a reminder (S62); `null` until then, or once moved. */
  clientConfirmedAt: string | null;
  /** How they confirmed (S78): by "C" or their link; `null` or absent: by text. */
  clientConfirmedVia?: 'text' | 'link' | null;
  /** The series of recurring visits it is part of (S72); `null` or absent: a single booking. */
  seriesId?: string | null;
  /** Pepper kept it over a change made in Google lately (S72 top-up, AC-X-188). */
  keptOverGoogle?: boolean;
  /** Its place in its series, "2 of 8" (S72.2 top-up, AC-X-194). */
  visit?: { number: number; of: number } | null;
}

/**
 * A booking on the calendar, as a button that opens its sheet: the details, done or no-show
 * once it has started, move and cancel. Every change goes through `PATCH /v1/bookings/:id`,
 * which checks it again (staff: their own bookings; done and no-show final for them). A move or
 * cancellation emails the client unless the team unticks it (ADR-0025). On the kit (S42.2):
 * each view's actions sit in the sheet's footer, within thumb reach (D3).
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
          aria-label={bookingBlockName(timeZone, booking)}
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
  const depositRead = useBookingDeposit(booking.id, abilities.readsPayments);
  const deposit = teamDepositLine(depositRead, timeZone);
  const calendarAnswer = useBookingCalendarState(
    booking.id,
    `${booking.status} ${booking.startsAt} ${booking.staffMemberId}`,
  );
  const inGoogle = bookingCalendarLine(calendarAnswer?.state ?? null);
  const keptOverGoogle = keptOverGoogleLine(calendarAnswer);
  const series = useBookingSeries(booking.seriesId ?? null);
  const repeats = series === null ? null : seriesLine(series, booking.id);
  const later = series === null ? [] : laterVisits(series, booking);
  const [cancelScope, setCancelScope] = useState<'this' | 'following'>('this');

  async function cancelFollowing(): Promise<void> {
    setBusy(true);
    const answer = await sendJson(
      'POST',
      `/v1/bookings/${encodeURIComponent(booking.id)}/cancel-following`,
      { notifyClient },
    );
    setBusy(false);
    if (answer.ok && CancelFollowingResultSchema.safeParse(answer.data).success) {
      onDone();
      router.refresh();
      return;
    }
    setError(answer.ok ? 'Something went wrong.' : answer.message);
  }

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

  const confirmedAt = confirmedByText(booking);
  const summary = (
    <DetailTable
      rows={[
        {
          label: 'Client',
          value:
            booking.clientId === null ? (
              <span data-testid="booking-client">{booking.client}</span>
            ) : (
              <Link
                href={`${ROUTES.clients}/${encodeURIComponent(booking.clientId)}`}
                // A tap target of its own, not a link in a sentence (D3: at least 44 px).
                className="inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-2"
                data-testid="booking-client"
              >
                {booking.client}
              </Link>
            ),
        },
        {
          label: 'When',
          value: (
            <span className="tabular-nums" data-testid="booking-when">
              {dateTimeLabel(timeZone, booking.startsAt)} – {timeLabel(timeZone, booking.endsAt)}
            </span>
          ),
        },
        ...(repeats === null
          ? []
          : [
              {
                label: 'Repeats',
                value: (
                  <span className="tabular-nums" data-testid="booking-series">
                    {repeats}
                  </span>
                ),
              },
            ]),
        {
          label: 'Status',
          value: <span data-testid="booking-status">{STATUS_LABELS[booking.status]}</span>,
        },
        ...(confirmedAt === null
          ? []
          : [
              {
                label: 'Reply',
                value: (
                  <span className="text-ok" data-testid="booking-confirmed-by-text">
                    {confirmedLabel(booking)}
                    <span
                      className="block text-ink-2 tabular-nums"
                      data-testid="booking-confirmed-when"
                    >
                      {dateTimeLabel(timeZone, confirmedAt)}
                    </span>
                  </span>
                ),
              },
            ]),
        ...(deposit === null
          ? []
          : [
              {
                label: 'Deposit',
                value: (
                  <span className="tabular-nums" data-testid="booking-deposit">
                    {deposit}
                  </span>
                ),
              },
            ]),
        ...(inGoogle === null
          ? []
          : [
              {
                label: 'Calendar',
                value: (
                  <span className="text-ink-2" data-testid="booking-google-calendar">
                    {inGoogle}
                    {keptOverGoogle === null ? null : (
                      <span className="block type-caption" data-testid="booking-google-kept">
                        {keptOverGoogle}
                      </span>
                    )}
                  </span>
                ),
              },
            ]),
        ...(booking.overridden
          ? [
              {
                label: 'Note',
                value: <span className="text-warn">Booked outside the usual hours</span>,
              },
            ]
          : []),
      ]}
    />
  );

  if (view === 'cancel') {
    return (
      <div className="grid gap-4">
        {summary}
        {later.length === 0 ? (
          <p className="m-0 type-body font-semibold">
            Cancel this booking? The time becomes free again.
          </p>
        ) : (
          <>
            <Segmented
              label="Which visits"
              options={[
                { value: 'this', label: 'Just this visit' },
                { value: 'following', label: `This and following (${String(later.length + 1)})` },
              ]}
              value={cancelScope}
              onValueChange={(value) => {
                setCancelScope(value === 'following' ? 'following' : 'this');
              }}
            />
            <p className="m-0 type-body font-semibold" data-testid="booking-cancel-scope">
              {cancelScope === 'this'
                ? 'Cancel this visit? The later ones stay booked.'
                : `Cancel this visit and the ${String(later.length)} after it? Their times become free again.`}
            </p>
          </>
        )}
        {teamCancelDepositWords(depositRead) === null ? null : (
          <p className="m-0 type-body text-ink-2" data-testid="booking-cancel-deposit">
            {teamCancelDepositWords(depositRead)}
          </p>
        )}
        <NotifyClient checked={notifyClient} onChange={setNotifyClient}>
          {cancelScope === 'following' && later.length > 0
            ? 'Email the client one note with the cancelled dates'
            : 'Email the client that it is cancelled'}
        </NotifyClient>
        <SheetFooter>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          <Button
            block
            size="lg"
            variant="danger"
            busy={busy}
            onClick={() => {
              if (cancelScope === 'following' && later.length > 0) void cancelFollowing();
              else void change({ status: 'cancelled', notifyClient });
            }}
          >
            {cancelScope === 'following' && later.length > 0
              ? `Cancel ${String(later.length + 1)} visits`
              : 'Cancel booking'}
          </Button>
          <Button
            block
            variant="quiet"
            onClick={() => {
              setView('details');
              setError(null);
            }}
          >
            Keep it
          </Button>
        </SheetFooter>
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
      {abilities.readsNotes && booking.status !== 'cancelled' ? (
        <VisitNotes
          bookingId={booking.id}
          timeZone={timeZone}
          // Staff change only their own visits' notes (the api decides; this hides the form).
          canChange={
            abilities.managesNotes &&
            (!abilities.ownStaffOnly ||
              setup.staff.some(
                (member) => member.id === booking.staffMemberId && member.userId === setup.userId,
              ))
          }
        />
      ) : null}
      {none ? (
        <p className="m-0 type-body text-ink-2">
          {booking.status === 'cancelled' || abilities.correctsOutcomes
            ? 'Nothing more to change here.'
            : 'This is recorded. An owner or manager can correct it if needed.'}
        </p>
      ) : (
        <SheetFooter>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          {actions.complete ? (
            <Button
              block
              size="lg"
              busy={busy}
              onClick={() => void change({ status: 'completed' })}
            >
              Mark done
            </Button>
          ) : null}
          {actions.noShow || actions.move ? (
            <div className="flex gap-2">
              {actions.noShow ? (
                <Button
                  variant="secondary"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => void change({ status: 'no_show' })}
                >
                  No-show
                </Button>
              ) : null}
              {actions.move ? (
                // Before the visit starts, moving it is the main thing left to do (D4).
                <Button
                  variant={actions.complete ? 'secondary' : 'primary'}
                  size={actions.complete ? 'md' : 'lg'}
                  className="flex-1"
                  onClick={() => {
                    setView('move');
                    setError(null);
                  }}
                >
                  Move
                </Button>
              ) : null}
            </div>
          ) : null}
          {actions.cancel ? (
            <Button
              block
              variant="danger"
              onClick={() => {
                setView('cancel');
                setError(null);
              }}
            >
              Cancel booking
            </Button>
          ) : null}
        </SheetFooter>
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
      <p className="m-0 type-body text-ink-2">
        Now <span className="tabular-nums">{dateTimeLabel(timeZone, booking.startsAt)}</span>. Pick
        the new time.
      </p>
      {choices.length > 1 ? (
        <Select
          label="With"
          name="staff"
          value={staffMemberId}
          options={choices.map((member) => ({ value: member.id, label: member.displayName }))}
          onChange={(event) => {
            setStaffMemberId(event.target.value);
            setStartsAt(null);
          }}
        />
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
      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        <Button
          block
          size="lg"
          disabled={startsAt === null}
          busy={busy}
          onClick={() => {
            if (startsAt !== null) onMove(startsAt, staffMemberId);
          }}
        >
          {busy ? 'Moving…' : 'Move here'}
        </Button>
        <Button block variant="quiet" onClick={onBack}>
          Back
        </Button>
      </SheetFooter>
    </div>
  );
}

/**
 * The booking's deposit (S67 top-up, AC-X-129), read when the sheet opens: owners and managers
 * only; `null` with none, while loading, or when payments are off here.
 */
function useBookingDeposit(bookingId: string, reads: boolean): BookingDeposit | null {
  const [deposit, setDeposit] = useState<BookingDeposit | null>(null);
  useEffect(() => {
    if (!reads) return;
    let current = true;
    void fetchJson(
      `/v1/payments/bookings/${encodeURIComponent(bookingId)}/deposit`,
      BookingDepositAnswerSchema,
    ).then((answer) => {
      if (current && answer.ok) setDeposit(answer.data.deposit);
    });
    return () => {
      current = false;
    };
  }, [bookingId, reads]);
  return deposit;
}

/**
 * The booking's series (S72, AC-X-186), read when the sheet opens: "Visit 3 of 8" and the later
 * visits "This and following" cancels; `null` for a single booking, while loading, or when it
 * can't be read (the sheet then offers the single cancel only).
 */
function useBookingSeries(seriesId: string | null): BookingSeries | null {
  const [series, setSeries] = useState<BookingSeries | null>(null);
  useEffect(() => {
    if (seriesId === null) return;
    let current = true;
    void fetchJson(`/v1/bookings/series/${encodeURIComponent(seriesId)}`, BookingSeriesSchema).then(
      (answer) => {
        if (current && answer.ok) setSeries(answer.data);
      },
    );
    return () => {
      current = false;
    };
  }, [seriesId]);
  return seriesId === null ? null : series;
}

/** How often an open sheet asks again while the booking is on its way to Google, and how many times. */
const CALENDAR_STATE_POLL_MS = 10_000;
const CALENDAR_STATE_POLLS = 12;

/**
 * Whether the booking is in Google Calendar (S71 top-up, AC-X-173), read when the sheet opens and
 * again after the booking changes (`version`: its status, time and staff member), and every 10 s
 * while it is on its way (two minutes at most); `null` while loading, with Google Calendar off
 * here, or when it can't be read (the sheet then says nothing about it).
 */
function useBookingCalendarState(bookingId: string, version: string): BookingCalendarState | null {
  const [state, setState] = useState<BookingCalendarState | null>(null);
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Another booking or a change: never the last one's answer meanwhile.
    setState(null);
    const read = (polls: number): void => {
      void fetchJson(bookingCalendarPath(bookingId), BookingCalendarStateSchema).then((answer) => {
        if (!current) return;
        const next = answer.ok ? answer.data : null;
        setState(next);
        if (next?.state === 'pending' && polls > 0) {
          timer = setTimeout(() => {
            read(polls - 1);
          }, CALENDAR_STATE_POLL_MS);
        }
      });
    };
    read(CALENDAR_STATE_POLLS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [bookingId, version]);
  return state;
}
