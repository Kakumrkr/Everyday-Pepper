'use client';

import {
  MemberTextsSchema,
  StartPhoneCheckResponseSchema,
  type MemberTexts,
} from '@pepper/contracts';
import { Button, buttonStyle, Input, Sheet, SheetFooter, Switch, Toast } from '@pepper/ui';
import { useId, useState, type SubmitEvent } from 'react';
import { sendJson } from '../../../lib/client-api';
import {
  cardTextsHint,
  cardTextsSavedNote,
  checkedNote,
  codeSentLine,
  isCodeShaped,
  MEMBER_PHONE_PATH,
  MEMBER_PHONE_VERIFY_PATH,
  MEMBER_TEXTS_PATH,
  numberAction,
  numberLine,
} from '../../../lib/member-texts';
import { Notice } from '../form-parts';

/** The toast after a change; `id` makes a second one show afresh. */
interface Note {
  id: number;
  text: string;
  tone: 'note' | 'error';
}

const FALLBACK = 'Something went wrong. Try again.';

/**
 * "Cards to your phone" on Texts and reminders (S63.2, AC-X-88/89, ADR-0066): the member's own
 * checked number and "Text me cards" for this business. Owners and managers only (the page
 * leaves it out for staff); the api checks the number with a texted code and records the words
 * shown under the switch as the member's consent.
 */
export function CardTextsSection({
  initial,
  businessName,
}: {
  initial: MemberTexts;
  businessName: string;
}) {
  const [texts, setTexts] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const headingId = useId();

  function say(text: string, tone: Note['tone'] = 'note'): void {
    setNote((last) => ({ id: (last?.id ?? 0) + 1, text, tone }));
  }

  async function changeCards(on: boolean): Promise<void> {
    const before = texts;
    setTexts({ ...texts, cardTexts: on });
    setBusy(true);
    const answer = await sendJson('PATCH', MEMBER_TEXTS_PATH, { cardTexts: on });
    setBusy(false);
    const parsed = answer.ok ? MemberTextsSchema.safeParse(answer.data) : null;
    if (parsed?.success === true) {
      setTexts(parsed.data);
      say(cardTextsSavedNote(parsed.data.cardTexts));
    } else {
      setTexts(before);
      say(answer.ok ? FALLBACK : answer.message, 'error');
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="m-0 type-heading">
        Cards to your phone
      </h2>
      <p className="m-0 type-body text-ink-2">
        When something needs your OK, like a waitlist offer, I can text it to you. Reply Y and the
        code to approve it from anywhere.
      </p>
      <div
        className="flex flex-col divide-y divide-line rounded-lg bg-surface px-4"
        data-testid="card-texts"
      >
        <div className="flex min-h-14 items-center justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="m-0 type-label text-ink-2">Your number</p>
            <p
              className="m-0 type-body font-semibold text-ink tabular-nums"
              data-testid="my-number"
            >
              {numberLine(texts)}
            </p>
          </div>
          <NumberSheet
            texts={texts}
            onChecked={(after) => {
              say(checkedNote(texts, after));
              setTexts(after);
            }}
          />
        </div>
        <Switch
          label="Text me cards"
          hint={cardTextsHint(texts, businessName)}
          checked={texts.cardTexts}
          disabled={busy || texts.phone === null}
          onChange={(event) => void changeCards(event.target.checked)}
        />
      </div>
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
    </section>
  );
}

/** Where the sheet is: typing the number, or the code texted to it. */
type Step = { kind: 'number' } | { kind: 'code'; typed: string; line: string };

/**
 * The number, then the 6-digit code texted to it (AC-X-88): `POST /v1/me/phone`, then
 * `POST /v1/me/phone/verify`. Each refusal says what to do (the api's codes, `client-api.ts`).
 */
function NumberSheet({
  texts,
  onChecked,
}: {
  texts: MemberTexts;
  onChecked: (after: MemberTexts) => void;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'number' });
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  function reset(): void {
    setStep({ kind: 'number' });
    setPhone('');
    setCode('');
    setError(null);
  }

  async function sendCode(typed: string): Promise<void> {
    setBusy(true);
    setError(null);
    const answer = await sendJson('POST', MEMBER_PHONE_PATH, { phone: typed });
    setBusy(false);
    const parsed = answer.ok ? StartPhoneCheckResponseSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setError(answer.ok ? FALLBACK : answer.message);
      return;
    }
    setCode('');
    setStep({ kind: 'code', typed, line: codeSentLine(typed, parsed.data.expiresAt, new Date()) });
  }

  async function check(): Promise<void> {
    setBusy(true);
    setError(null);
    const answer = await sendJson('POST', MEMBER_PHONE_VERIFY_PATH, { code: code.trim() });
    setBusy(false);
    const parsed = answer.ok ? MemberTextsSchema.safeParse(answer.data) : null;
    if (parsed?.success !== true) {
      setError(answer.ok ? FALLBACK : answer.message);
      return;
    }
    setOpen(false);
    reset();
    onChecked(parsed.data);
  }

  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (busy) return;
    if (step.kind === 'number') void sendCode(phone);
    else if (isCodeShaped(code)) void check();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
      title={step.kind === 'number' ? 'Your mobile number' : 'Type the code'}
      description={
        step.kind === 'number'
          ? 'I’ll text it a code to check it’s yours. Cards come only to a number you’ve checked.'
          : step.line
      }
      trigger={
        <button type="button" className={buttonStyle({ variant: 'secondary', size: 'sm' })}>
          {numberAction(texts)}
        </button>
      }
    >
      <form id={formId} onSubmit={submit} className="grid gap-4" data-testid="number-sheet">
        {step.kind === 'number' ? (
          <Input
            key="phone"
            label="Mobile number"
            hint="A US or Canadian mobile."
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            required
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
            }}
          />
        ) : (
          <Input
            key="code"
            label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(event) => {
              // A pasted "482 193" or "482-193" keeps all six digits (no maxLength to cut it).
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
            }}
          />
        )}
        <SheetFooter>
          {error === null ? null : <Notice tone="error">{error}</Notice>}
          {step.kind === 'number' ? (
            <Button
              block
              size="lg"
              type="submit"
              form={formId}
              busy={busy}
              disabled={phone.trim() === ''}
            >
              {busy ? 'Sending…' : 'Text me a code'}
            </Button>
          ) : (
            <>
              <Button
                block
                size="lg"
                type="submit"
                form={formId}
                busy={busy}
                disabled={!isCodeShaped(code)}
              >
                {busy ? 'Checking…' : 'Check the code'}
              </Button>
              <Button
                block
                variant="quiet"
                disabled={busy}
                onClick={() => void sendCode(step.typed)}
              >
                Text me a new code
              </Button>
              <Button
                block
                variant="quiet"
                disabled={busy}
                onClick={() => {
                  setStep({ kind: 'number' });
                  setError(null);
                }}
              >
                Use another number
              </Button>
            </>
          )}
        </SheetFooter>
      </form>
    </Sheet>
  );
}
