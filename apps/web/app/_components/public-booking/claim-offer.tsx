'use client';

import {
  BookingConfirmResponseSchema,
  PublicOfferResponseSchema,
  type PublicBooking,
  type PublicBusiness,
  type PublicOffer,
} from '@pepper/contracts';
import { Button, buttonStyle, DetailTable } from '@pepper/ui';
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
import { Notice } from '../form-parts';

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
      <p className="m-0 type-body text-ink-2" role="status">
        Opening your offer…
      </p>
    );
  }
  if (view.state === 'broken') {
    return (
      <>
        <h1 className="m-0 type-display text-ink">A time opened up</h1>
        <Notice tone="error">{view.message}</Notice>
        <a
          href={`/book/${encodeURIComponent(slug)}`}
          className={`${buttonStyle({ variant: 'secondary' })} self-start`}
        >
          Book a visit
        </a>
      </>
    );
  }
  if (view.state === 'booked') {
    return (
      <div className="flex flex-col gap-5">
        <h1 className="m-0 type-display text-ink">You’re booked</h1>
        <Notice tone="ok">
          {view.booking.service.name} with {view.booking.staff.displayName},{' '}
          {dateTimeLabel(timeZone, view.booking.startsAt)}. We emailed you the details.
        </Notice>
        <a
          href={managePath(slug, view.manageToken)}
          className={`${buttonStyle({ variant: 'secondary' })} self-start`}
        >
          Reschedule or cancel
        </a>
      </div>
    );
  }

  const { offer } = view;
  const closed = offerStateText(offer.status);
  return (
    <div className="flex flex-col gap-5">
      <h1 className="m-0 type-display text-ink">A time opened up</h1>
      {closed === null ? null : <Notice tone="error">{closed}</Notice>}
      {error === null ? null : <Notice tone="error">{error}</Notice>}
      <DetailTable
        className="rounded-lg bg-surface px-4"
        rows={[
          { label: 'Service', value: offer.service.name },
          { label: 'With', value: offer.staff.displayName },
          {
            label: 'When',
            value: <span className="tabular-nums">{dateTimeLabel(timeZone, offer.startsAt)}</span>,
          },
        ]}
      />
      {closed === null ? (
        <>
          <p className="m-0 type-body text-ink-2">
            A few people on the waitlist were offered this time, and the first to claim it gets it.
            The offer ends {dateTimeLabel(timeZone, offer.expiresAt)}.
          </p>
          <Button size="lg" block busy={busy} onClick={() => void claim(offer)}>
            {busy ? 'Claiming…' : 'Claim this time'}
          </Button>
        </>
      ) : (
        <a
          href={`/book/${encodeURIComponent(slug)}`}
          className={`${buttonStyle({ variant: 'secondary' })} self-start`}
        >
          See other times
        </a>
      )}
    </div>
  );
}
