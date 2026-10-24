'use client';

import {
  BookingConfirmResponseSchema,
  PublicOfferResponseSchema,
  type PublicBooking,
  type PublicBusiness,
  type PublicOffer,
} from '@pepper/contracts';
import { buttonClass } from '@pepper/ui';
import { useEffect, useState } from 'react';
import { dateTimeLabel } from '../../../lib/booking';
import { sendJson } from '../../../lib/client-api';
import {
  managePath,
  offerStateText,
  publicApiPath,
  readOfferToken,
  refusedClaimStatus,
} from '../../../lib/public-booking';
import { Notice } from '../booking/sheet';

type View =
  | { state: 'loading' }
  | { state: 'broken'; message: string }
  | { state: 'ready'; offer: PublicOffer }
  | { state: 'booked'; booking: PublicBooking; manageToken: string };

/**
 * A freed time offered to a client on the waitlist (`/book/<slug>/offer#<token>`, S37). The
 * page shows the time and until when it may be claimed; the client's tap claims it, and the
 * first claim books it. A used, taken or expired offer says so, never who has the time.
 */
export function ClaimOffer({ business }: { business: PublicBusiness }) {
  const { slug, timeZone } = business;
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<View>({ state: 'loading' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = readOfferToken(window.location.hash);
    setToken(read);
    if (read === null) {
      setView({ state: 'broken', message: 'This link is incomplete. Open it from your email.' });
      return;
    }
    void sendJson('POST', publicApiPath(slug, '/waitlist-offer/lookup'), { token: read }).then(
      (answer) => {
        const parsed = answer.ok ? PublicOfferResponseSchema.safeParse(answer.data) : null;
        setView(
          parsed?.success === true
            ? { state: 'ready', offer: parsed.data.offer }
            : {
                state: 'broken',
                message: answer.ok ? 'Something went wrong. Try again.' : answer.message,
              },
        );
      },
    );
  }, [slug]);

  async function claim(offer: PublicOffer): Promise<void> {
    if (token === null) return;
    setBusy(true);
    setError(null);
    const answer = await sendJson('POST', publicApiPath(slug, '/waitlist-offer/claim'), { token });
    setBusy(false);
    const parsed = answer.ok ? BookingConfirmResponseSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setView({
        state: 'booked',
        booking: parsed.data.booking,
        manageToken: parsed.data.manageToken,
      });
      return;
    }
    const now = refusedClaimStatus(answer);
    if (now !== null) {
      // Taken, used or expired: show the offer as it is now.
      setView({ state: 'ready', offer: { ...offer, status: now } });
      return;
    }
    setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
  }

  if (view.state === 'loading') {
    return (
      <p className="m-0 text-ink-2" role="status">
        Opening your offer…
      </p>
    );
  }
  if (view.state === 'broken') {
    return (
      <>
        <h1 className="m-0 font-display text-2xl font-bold">A time opened up</h1>
        <Notice tone="error">{view.message}</Notice>
        <a
          href={`/book/${encodeURIComponent(slug)}`}
          className={buttonClass({ variant: 'secondary' })}
        >
          Book a visit
        </a>
      </>
    );
  }
  if (view.state === 'booked') {
    return (
      <div className="grid gap-4">
        <h1 className="m-0 font-display text-2xl font-bold">You’re booked</h1>
        <Notice tone="ok">
          {view.booking.service.name} with {view.booking.staff.displayName},{' '}
          {dateTimeLabel(timeZone, view.booking.startsAt)}. We emailed you the details.
        </Notice>
        <a
          href={managePath(slug, view.manageToken)}
          className={buttonClass({ variant: 'secondary' })}
        >
          Reschedule or cancel
        </a>
      </div>
    );
  }

  const { offer } = view;
  const closed = offerStateText(offer.status);
  return (
    <div className="grid gap-4">
      <h1 className="m-0 font-display text-2xl font-bold">A time opened up</h1>
      {closed === null ? null : <Notice tone="error">{closed}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-line bg-surface p-4">
        <dt className="text-ink-2">Service</dt>
        <dd className="m-0 font-semibold">{offer.service.name}</dd>
        <dt className="text-ink-2">With</dt>
        <dd className="m-0 font-semibold">{offer.staff.displayName}</dd>
        <dt className="text-ink-2">When</dt>
        <dd className="m-0 font-semibold">{dateTimeLabel(timeZone, offer.startsAt)}</dd>
      </dl>
      {closed === null ? (
        <>
          <p className="m-0 text-ink-2">
            A few people on the waitlist were offered this time; whoever claims it first gets it.
            The offer ends {dateTimeLabel(timeZone, offer.expiresAt)}.
          </p>
          <button
            type="button"
            className={buttonClass({ variant: 'primary' })}
            disabled={busy}
            onClick={() => void claim(offer)}
          >
            {busy ? 'Claiming…' : 'Claim this time'}
          </button>
        </>
      ) : (
        <a
          href={`/book/${encodeURIComponent(slug)}`}
          className={buttonClass({ variant: 'secondary' })}
        >
          See other times
        </a>
      )}
    </div>
  );
}
