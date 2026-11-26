'use client';

import { CalendarConnectStartSchema, type CalendarConnectionAnswer } from '@pepper/contracts';
import { Badge, Button, Sheet, SheetFooter } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../../../lib/account';
import {
  CALENDAR_CONNECT_PATH,
  CALENDAR_GOOGLE_PATH,
  calendarWords,
  outcomeNote,
  type GoogleOutcome,
} from '../../../lib/calendar-connect';
import { errorCodeOf, sendJson } from '../../../lib/client-api';
import { Notice } from '../form-parts';

const FALLBACK = 'Something went wrong. Try again.';

/** What happened, said at the top: a finished connect, a refusal, a disconnect. */
interface Said {
  tone: 'ok' | 'error';
  text: string;
}

type Busy = 'connect' | 'disconnect' | null;

/**
 * The member's own Google Calendar (S70.2, AC-X-160…162): where it stands, Connect or
 * Reconnect (Google's consent page), and Disconnect behind a confirm. Coming from Google's
 * return (`outcome`, finished on the server), it says how that ended and cleans the address so
 * a reload doesn't say it again.
 */
export function CalendarPanel({
  initial,
  timeZone,
  outcome,
}: {
  initial: CalendarConnectionAnswer;
  timeZone: string;
  outcome: GoogleOutcome | null;
}) {
  const router = useRouter();
  const [answer, setAnswer] = useState(initial);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<Said | null>(() => outcomeNote(outcome));
  const [confirming, setConfirming] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    // Once (React runs effects twice in development); the same page, so nothing remounts.
    if (handled.current || outcome === null) return;
    handled.current = true;
    router.replace(ROUTES.calendarSettings, { scroll: false });
    // Once only: the ref guards it, so `router` needn't be listed.
  }, [outcome]);

  useEffect(() => {
    // Back from Google's page with the browser's back button: the page comes back as it was
    // left, with Connect still busy.
    const restored = (event: PageTransitionEvent): void => {
      if (event.persisted) setBusy(null);
    };
    window.addEventListener('pageshow', restored);
    return () => {
      window.removeEventListener('pageshow', restored);
    };
  }, []);

  /** Asks the api for Google's consent page and goes there; the button stays busy meanwhile. */
  async function connect(): Promise<void> {
    setBusy('connect');
    setSaid(null);
    const result = await sendJson('POST', CALENDAR_CONNECT_PATH, undefined);
    const parsed = result.ok ? CalendarConnectStartSchema.safeParse(result.data) : null;
    if (parsed?.success === true) {
      window.location.assign(parsed.data.url);
      return;
    }
    setBusy(null);
    setSaid({ tone: 'error', text: result.ok ? FALLBACK : result.message });
  }

  async function disconnect(): Promise<void> {
    setBusy('disconnect');
    const result = await sendJson('DELETE', CALENDAR_GOOGLE_PATH, undefined);
    setBusy(null);
    setConfirming(false);
    // Already gone is what the member wanted too; any other refusal (off here) is said.
    if (result.ok || errorCodeOf(result.body) === 'calendar_not_connected') {
      setAnswer((last) => ({ ...last, connection: null }));
      setSaid({
        tone: 'ok',
        text: 'Disconnected. Your Google busy times no longer block bookings.',
      });
    } else {
      setSaid({ tone: 'error', text: result.message });
    }
  }

  const words = calendarWords(answer, timeZone);

  return (
    <div className="flex flex-col gap-6">
      {said === null ? null : <Notice tone={said.tone}>{said.text}</Notice>}

      <section
        aria-labelledby="calendar-google"
        className="flex flex-col gap-3 rounded-lg bg-surface p-4"
        data-testid="calendar-status"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="calendar-google" className="m-0 type-heading">
            Google Calendar
          </h2>
          <Badge tone={words.tone}>{words.badge}</Badge>
        </div>
        {words.lines.map((line) => (
          <p key={line} className="m-0 type-body text-ink-2 break-words">
            {line}
          </p>
        ))}
      </section>

      {words.action === null && !words.disconnect ? null : (
        <div className="flex flex-col gap-3">
          {words.action === null ? null : (
            <Button
              block
              size="lg"
              busy={busy === 'connect'}
              disabled={busy !== null && busy !== 'connect'}
              onClick={() => {
                void connect();
              }}
            >
              {busy === 'connect' ? 'Opening Google…' : words.action}
            </Button>
          )}
          {words.disconnect ? (
            <Sheet
              open={confirming}
              onOpenChange={setConfirming}
              title="Disconnect Google Calendar?"
              description={words.disconnectNote}
              trigger={
                <Button variant="secondary" block disabled={busy !== null}>
                  Disconnect
                </Button>
              }
            >
              <SheetFooter>
                <Button
                  block
                  size="lg"
                  variant="danger"
                  busy={busy === 'disconnect'}
                  onClick={() => {
                    void disconnect();
                  }}
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </Button>
                <Button
                  block
                  variant="quiet"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Keep it connected
                </Button>
              </SheetFooter>
            </Sheet>
          ) : null}
        </div>
      )}
    </div>
  );
}
