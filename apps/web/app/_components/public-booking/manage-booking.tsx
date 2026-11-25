'use client';

import {
  PublicBookingResponseSchema,
  type AvailableSlot,
  type PublicBooking,
  type PublicBusiness,
} from '@pepper/contracts';
import { Button, buttonStyle, cx, chipStyle, DetailTable } from '@pepper/ui';
import { useEffect, useMemo, useState } from 'react';
import { dateTimeLabel, STATUS_LABELS } from '../../../lib/booking';
import { sendJson, type CallResult } from '../../../lib/client-api';
import { manageDepositWords } from '../../../lib/deposits';
import { publicApiPath, readManageToken } from '../../../lib/public-booking';
import { Notice } from '../form-parts';
import { alternativesOf } from '../booking/refusal';
import { ForgetDevice, Policy } from './booking-flow';
import { SlotPicker } from './slot-picker';

type View =
  | { state: 'loading' }
  | { state: 'broken'; message: string }
  | { state: 'ready'; booking: PublicBooking };

/**
 * The client's own booking behind the link in their email (`/book/<slug>/manage#<token>`).
 * The secret stays in the fragment: the page reads it in the browser and sends it only in
 * POST bodies. While the booking may still change, it can be moved (same service and staff
 * member) or cancelled.
 */
export function ManageBooking({ business, now }: { business: PublicBusiness; now: number }) {
  const { slug, timeZone } = business;
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [mode, setMode] = useState<'view' | 'move' | 'cancel'>('view');
  // "Forget this phone" (S47, AC-W8-8): shown on every visit (the cookie is unreadable here).
  const [forgotten, setForgotten] = useState<'forgotten' | 'unknown' | null>(null);
  const [alternatives, setAlternatives] = useState<AvailableSlot[] | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const staffNames = useMemo(
    () => new Map<string, string>(business.staff.map((member) => [member.id, member.displayName])),
    [business.staff],
  );

  useEffect(() => {
    const read = readManageToken(window.location.hash);
    setToken(read);
    if (read === null) {
      setView({ state: 'broken', message: 'This link is incomplete. Open it from your email.' });
      return;
    }
    void sendJson('POST', publicApiPath(slug, '/booking/lookup'), { token: read }).then(
      (answer) => {
        const parsed = answer.ok ? PublicBookingResponseSchema.safeParse(answer.data) : null;
        setView(
          parsed?.success === true
            ? { state: 'ready', booking: parsed.data.booking }
            : {
                state: 'broken',
                message:
                  !answer.ok && answer.status === 404
                    ? 'We couldn’t find this booking. Check the link in your email.'
                    : answer.ok
                      ? 'Something went wrong. Try again.'
                      : answer.message,
              },
        );
      },
    );
  }, [slug]);

  function settle(answer: CallResult<unknown>, done: string): void {
    const parsed = answer.ok ? PublicBookingResponseSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setView({ state: 'ready', booking: parsed.data.booking });
      setMode('view');
      setAlternatives(null);
      setNotice({ tone: 'ok', text: done });
      return;
    }
    const others = alternativesOf(answer);
    if (others !== null) {
      setAlternatives(others);
      setNotice({ tone: 'error', text: 'Someone just took that time. Pick another one.' });
      return;
    }
    setNotice({
      tone: 'error',
      text: answer.ok ? 'Something went wrong. Try again.' : answer.message,
    });
  }

  async function move(startsAt: string): Promise<void> {
    if (token === null) return;
    setBusy(true);
    const answer = await sendJson('POST', publicApiPath(slug, '/booking/reschedule'), {
      token,
      startsAt,
    });
    setBusy(false);
    settle(answer, `Moved to ${dateTimeLabel(timeZone, startsAt)}. We emailed you the new time.`);
  }

  async function cancel(): Promise<void> {
    if (token === null) return;
    setBusy(true);
    const answer = await sendJson('POST', publicApiPath(slug, '/booking/cancel'), { token });
    setBusy(false);
    settle(answer, 'Your booking is cancelled.');
  }

  if (view.state === 'loading') {
    return (
      <p className="m-0 type-body text-ink-2" role="status">
        Opening your booking…
      </p>
    );
  }
  if (view.state === 'broken') {
    return (
      <>
        <h1 className="m-0 type-display text-ink">Your booking</h1>
        <Notice tone="error">{view.message}</Notice>
        <a
          href={`/book/${encodeURIComponent(slug)}`}
          className={cx(buttonStyle({ variant: 'secondary' }), 'self-start')}
        >
          Book a visit
        </a>
      </>
    );
  }

  const { booking } = view;
  // What cancelling does to the deposit, and where it stands (S66.2, AC-X-123).
  const deposit = manageDepositWords(booking.deposit, timeZone);
  return (
    <div className="flex flex-col gap-5">
      <h1 className="m-0 type-display text-ink">Your booking</h1>
      {notice === null ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      <DetailTable
        className="rounded-lg bg-surface px-4"
        rows={[
          { label: 'Service', value: booking.service.name },
          { label: 'With', value: booking.staff.displayName },
          {
            label: 'When',
            value: (
              <span className="tabular-nums">{dateTimeLabel(timeZone, booking.startsAt)}</span>
            ),
          },
          {
            label: 'Status',
            value: <span data-testid="booking-status">{STATUS_LABELS[booking.status]}</span>,
          },
        ]}
      />
      {deposit.status === null ? null : (
        <p className="m-0 type-body text-ink-2" data-testid="deposit-status">
          {deposit.status}
        </p>
      )}
      {!booking.changeable ? (
        booking.status === 'cancelled' ? (
          <a
            href={`/book/${encodeURIComponent(slug)}`}
            className={cx(buttonStyle({ variant: 'secondary' }), 'self-start')}
          >
            Book again
          </a>
        ) : (
          <p className="m-0 type-body text-ink-2">
            {`This booking can’t be changed online any more. Call or message ${business.name}.`}
          </p>
        )
      ) : mode === 'view' ? (
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => {
              setNotice(null);
              setMode('move');
            }}
          >
            Reschedule
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setNotice(null);
              setMode('cancel');
            }}
          >
            Cancel booking
          </Button>
        </div>
      ) : mode === 'cancel' ? (
        <section
          aria-label="Cancel this booking"
          className="flex flex-col gap-4 rounded-lg bg-danger-soft p-5"
        >
          <p className="m-0 type-body font-semibold text-ink">
            Cancel this booking? This can’t be undone, and the time goes to someone else.
          </p>
          {deposit.beforeCancel === null ? null : (
            <p className="m-0 type-body text-ink" data-testid="cancel-deposit">
              {deposit.beforeCancel}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button variant="danger" busy={busy} onClick={() => void cancel()}>
              {busy ? 'Cancelling…' : 'Yes, cancel it'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setMode('view');
              }}
            >
              Keep it
            </Button>
          </div>
        </section>
      ) : (
        <section aria-label="Pick a new time" className="flex flex-col gap-4">
          <h2 className="m-0 type-heading text-ink">
            Pick a new time with {booking.staff.displayName}
          </h2>
          {alternatives === null || alternatives.length === 0 ? null : (
            <div className="flex flex-wrap gap-2" data-testid="alternatives">
              {alternatives.map((other) => (
                <button
                  key={other.startsAt}
                  type="button"
                  disabled={busy}
                  className={chipStyle(false)}
                  onClick={() => void move(other.startsAt)}
                >
                  {dateTimeLabel(timeZone, other.startsAt)}
                </button>
              ))}
            </div>
          )}
          <SlotPicker
            slug={slug}
            timeZone={timeZone}
            now={now}
            serviceId={booking.service.id}
            staffMemberId={booking.staff.id}
            staffNames={staffNames}
            onPick={(slot) => void move(slot.startsAt)}
          />
          <Button
            variant="quiet"
            size="sm"
            className="self-start"
            onClick={() => {
              setMode('view');
              setAlternatives(null);
            }}
          >
            Keep the current time
          </Button>
        </section>
      )}
      <Policy business={business} />
      <ForgetDevice slug={slug} forgotten={forgotten} onForgotten={setForgotten} />
    </div>
  );
}
