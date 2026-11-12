'use client';

import { ClientTextsSchema, type ClientTexts } from '@pepper/contracts';
import { Badge, Button, buttonStyle, DetailTable, Sheet, SheetFooter } from '@pepper/ui';
import { useState } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  consentHowLabel,
  consentMomentLabel,
  smsPhoneLabel,
  textsSummary,
} from '../../../lib/client-texts';
import { Notice } from '../form-parts';

// A client's "Text messages" on their profile (S61.2, AC-X-66, AC-X-67): one line on where their
// texts stand; one tap to the record of what they agreed to, the words exactly as shown, when
// and how ("when did I say yes?"); and, for owners and managers, "Stop texts". There is no
// "turn back on": only the client can, by replying START or ticking the box when they book.

export function ClientTextsSection({
  clientName,
  clientId,
  initial,
  timeZone,
  hasPhone,
}: {
  clientName: string;
  clientId: string;
  initial: ClientTexts;
  timeZone: string;
  hasPhone: boolean;
}) {
  const [texts, setTexts] = useState(initial);
  const summary = textsSummary(texts, clientName, { timeZone, hasPhone });
  return (
    <section aria-labelledby="client-texts" className="flex flex-col gap-3">
      <h2 id="client-texts" className="m-0 type-heading">
        Text messages
      </h2>
      <div className="flex flex-col gap-3 rounded-lg bg-surface p-4" data-testid="client-texts">
        <div className="flex items-start justify-between gap-3">
          <p className="m-0 type-body font-semibold text-ink">{summary.line}</p>
          <Badge tone={summary.badge.tone} className="shrink-0">
            {summary.badge.text}
          </Badge>
        </div>
        <p className="m-0 type-caption text-ink-2">{summary.next}</p>
        {texts.consent === null && !texts.canStop ? null : (
          <div className="flex flex-wrap gap-2">
            {texts.consent === null ? null : (
              <AgreedSheet clientName={clientName} texts={texts} timeZone={timeZone} />
            )}
            {texts.canStop ? (
              <StopSheet clientName={clientName} clientId={clientId} onStopped={setTexts} />
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

/** The record behind the line: the words as shown, when (to the minute), how and the number. */
function AgreedSheet({
  clientName,
  texts,
  timeZone,
}: {
  clientName: string;
  texts: ClientTexts;
  timeZone: string;
}) {
  const [open, setOpen] = useState(false);
  const { consent } = texts;
  if (consent === null) return null;
  return (
    <Sheet
      open={open}
      onOpenChange={setOpen}
      title={`What ${clientName} agreed to`}
      description="The words exactly as they saw them, next to the box they ticked."
      trigger={
        <button type="button" className={buttonStyle({ variant: 'secondary', size: 'sm' })}>
          What they agreed to
        </button>
      }
    >
      <div className="grid gap-4" data-testid="client-texts-record">
        <blockquote className="m-0 border-l-4 border-brand bg-surface-2 px-4 py-3 type-body text-ink">
          {consent.words}
        </blockquote>
        <div className="rounded-lg bg-surface px-4">
          <DetailTable
            rows={[
              {
                label: 'Said yes',
                value: (
                  <span className="tabular-nums">
                    {consentMomentLabel(timeZone, consent.givenAt)}
                  </span>
                ),
              },
              { label: 'How', value: consentHowLabel(consent.source) },
              {
                label: 'Number',
                value: <span className="tabular-nums">{smsPhoneLabel(consent.phone)}</span>,
              },
              ...(consent.stoppedAt === null
                ? []
                : [
                    {
                      label: 'Stopped',
                      value: (
                        <span className="tabular-nums">
                          {consentMomentLabel(timeZone, consent.stoppedAt)}
                        </span>
                      ),
                    },
                  ]),
            ]}
          />
        </div>
        <p className="m-0 type-caption text-ink-2">
          Kept as your record of their yes. It’s in your data export too.
        </p>
      </div>
    </Sheet>
  );
}

function StopSheet({
  clientName,
  clientId,
  onStopped,
}: {
  clientName: string;
  clientId: string;
  onStopped: (texts: ClientTexts) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function stop() {
    setBusy(true);
    const answer = await sendJson('POST', `/v1/clients/${clientId}/texts/stop`, {});
    setBusy(false);
    const parsed = answer.ok ? ClientTextsSchema.safeParse(answer.data) : null;
    if (!parsed?.success) {
      setError(answer.ok ? 'Something went wrong. Try again.' : answer.message);
      return;
    }
    setOpen(false);
    onStopped(parsed.data);
  }

  return (
    <Sheet
      title={`Stop texts to ${clientName}?`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
      trigger={
        <button type="button" className={buttonStyle({ variant: 'quiet', size: 'sm' })}>
          Stop texts
        </button>
      }
    >
      <div className="grid gap-4" data-testid="client-texts-stop">
        <p className="m-0 type-body text-ink">
          No more texts go to {clientName}, from the next one. I’ll email them their confirmations
          and reminders instead. Only {clientName} can turn texts back on, by replying START or
          ticking the box when they book online.
        </p>
        <SheetFooter>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          <Button block size="lg" variant="danger" busy={busy} onClick={() => void stop()}>
            {busy ? 'Stopping…' : 'Stop texts'}
          </Button>
          <Button
            block
            variant="quiet"
            onClick={() => {
              setOpen(false);
            }}
          >
            Keep texts on
          </Button>
        </SheetFooter>
      </div>
    </Sheet>
  );
}
