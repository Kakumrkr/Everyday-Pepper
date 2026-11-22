'use client';

import {
  PaymentAccountAnswerSchema,
  PaymentDashboardLinkSchema,
  PaymentOnboardingLinkSchema,
  type PaymentAccountAnswer,
} from '@pepper/contracts';
import { Badge, Button, Icon, Toast } from '@pepper/ui';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ROUTES } from '../../../lib/account';
import { sendJson } from '../../../lib/client-api';
import {
  checkedNote,
  dueDay,
  PAYMENTS_DASHBOARD_PATH,
  PAYMENTS_ONBOARDING_PATH,
  PAYMENTS_SYNC_PATH,
  paymentsActions,
  paymentsWords,
  requirementsInWords,
  returnedNote,
  type PaymentsArrival,
} from '../../../lib/payments';

/** The toast after an action; `id` makes a second one show fresh. */
interface Note {
  id: number;
  text: string;
  tone: 'note' | 'error';
}

type Busy = 'onboarding' | 'dashboard' | 'check' | null;

const FALLBACK = 'Something went wrong. Try again.';

/**
 * More → Payments (S65.2, AC-X-107…109, ADR-0067): where payments stand in words, what Stripe
 * still needs and by when, and the owner's buttons (Stripe's onboarding pages, the Express
 * dashboard, a fresh check). Coming back from Stripe (`?stripe=return`) it reads the account
 * again once, because the webhook may not have arrived yet; a run-out link (`?stripe=refresh`)
 * says so beside the button for a fresh one. Managers read it with no buttons.
 */
export function PaymentsPanel({
  initial,
  timeZone,
  arrival,
}: {
  initial: PaymentAccountAnswer;
  timeZone: string;
  arrival: PaymentsArrival;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(initial);
  const [busy, setBusy] = useState<Busy>(
    arrival === 'return' && initial.canManage ? 'check' : null,
  );
  const [note, setNote] = useState<Note | null>(null);
  // The notice for where the browser came from stays after the address is cleaned.
  const [came] = useState(arrival);
  const handled = useRef(false);

  function show(text: string, tone: Note['tone']): void {
    setNote((last) => ({ id: (last?.id ?? 0) + 1, text, tone }));
  }

  async function check(after: (answer: PaymentAccountAnswer) => string): Promise<void> {
    setBusy('check');
    const answer = await sendJson('POST', PAYMENTS_SYNC_PATH, undefined);
    setBusy(null);
    const parsed = answer.ok ? PaymentAccountAnswerSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setAccount(parsed.data);
      show(after(parsed.data), 'note');
    } else {
      show(answer.ok ? FALLBACK : answer.message, 'error');
    }
  }

  useEffect(() => {
    // Once per arrival (React runs effects twice in development).
    if (handled.current || arrival === null) return;
    handled.current = true;
    // A reload or a shared address shouldn't come back from Stripe again.
    router.replace(ROUTES.payments, { scroll: false });
    if (arrival === 'return' && initial.canManage) {
      void check((read) => returnedNote(read.status));
    }
    // Once only: the ref guards it, so `check` and `router` needn't be listed.
  }, [arrival]);

  /** Asks the api for one of Stripe's links and goes there; the button stays busy meanwhile. */
  async function go(kind: 'onboarding' | 'dashboard'): Promise<void> {
    setBusy(kind);
    const path = kind === 'onboarding' ? PAYMENTS_ONBOARDING_PATH : PAYMENTS_DASHBOARD_PATH;
    const schema = kind === 'onboarding' ? PaymentOnboardingLinkSchema : PaymentDashboardLinkSchema;
    const answer = await sendJson('POST', path, undefined);
    const parsed = answer.ok ? schema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      window.location.assign(parsed.data.url);
      return;
    }
    setBusy(null);
    show(answer.ok ? FALLBACK : answer.message, 'error');
  }

  const words = paymentsWords(account, timeZone);
  const actions = paymentsActions(account);
  const needs = account.status === 'action_needed' ? requirementsInWords(account.due) : [];
  const by = account.dueBy === null ? null : dueDay(account.dueBy, timeZone);

  return (
    <div className="flex flex-col gap-6">
      {came === 'refresh' && actions.onboarding !== null ? (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink" role="status">
          Stripe’s page timed out. Tap “{actions.onboarding}” to pick up where you left off.
        </p>
      ) : null}
      {came === 'sandbox-dashboard' ? (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink" role="status">
          This is the sandbox: Stripe’s dashboard would open here. No real money moves.
        </p>
      ) : null}
      {account.canManage ? null : (
        <p className="m-0 rounded-md bg-info-soft px-4 py-3 type-body text-ink">
          Only the owner connects and changes payments. This is where they stand today.
        </p>
      )}

      <section
        aria-labelledby="payments-status"
        className="flex flex-col gap-2 rounded-lg bg-surface p-4"
        data-testid="payments-status"
      >
        <div>
          <Badge tone={words.tone}>{words.badge}</Badge>
        </div>
        <h2 id="payments-status" className="m-0 type-heading">
          {words.title}
        </h2>
        <p className="m-0 type-body text-ink-2">{words.body}</p>
      </section>

      {needs.length === 0 ? null : (
        <section aria-labelledby="payments-needs" className="flex flex-col gap-2">
          <h2 id="payments-needs" className="m-0 type-subheading">
            What Stripe needs
          </h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-lg bg-surface p-0">
            {needs.map((need) => (
              <li key={need} className="flex items-start gap-3 px-4 py-3">
                <Icon name="alert" className="mt-0.5 text-warn" />
                <span className="flex flex-col gap-0.5">
                  <span className="type-body font-semibold text-ink">{need}</span>
                  {by === null ? null : <span className="type-caption text-ink-2">By {by}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {actions.onboarding === null && !actions.dashboard && !actions.check ? null : (
        <div className="flex flex-col gap-3 desk:flex-row">
          {actions.onboarding === null ? null : (
            <Button
              block
              busy={busy === 'onboarding'}
              disabled={busy !== null}
              onClick={() => void go('onboarding')}
            >
              {actions.onboarding}
            </Button>
          )}
          {actions.dashboard ? (
            <Button
              block
              variant={actions.onboarding === null ? 'primary' : 'secondary'}
              busy={busy === 'dashboard'}
              disabled={busy !== null}
              onClick={() => void go('dashboard')}
            >
              Open your Stripe dashboard
            </Button>
          ) : null}
          {actions.check ? (
            <Button
              block
              variant="quiet"
              busy={busy === 'check'}
              disabled={busy !== null}
              onClick={() => void check((read) => checkedNote(read.status))}
            >
              Check with Stripe now
            </Button>
          ) : null}
        </div>
      )}

      <p className="m-0 flex items-start gap-2 type-caption text-ink-2">
        <Icon name="lock" className="text-ink-2" />
        Stripe keeps your bank account and ID. Pepper never sees them.
      </p>

      {note === null ? null : (
        <Toast
          key={note.id}
          open
          tone={note.tone}
          title={note.text}
          onOpenChange={(open) => {
            if (!open) setNote(null);
          }}
        />
      )}
    </div>
  );
}
