import type { AiMemoryView, AutonomyAction, ChangeSide } from '@pepper/contracts';
import { useId, type ReactNode } from 'react';
import { cx } from '../class-names.js';
import { Icon } from '../icons.js';
import { DetailTable } from '../kit/blocks.js';
import { Button } from '../kit/button.js';
import { Badge, type BadgeTone } from '../kit/marks.js';
import {
  ACTION_LABEL,
  changeRows,
  clientNameFor,
  decisionLabels,
  emailLine,
  formatDate,
  keyWords,
  memoryLine,
  undoLine,
  type EmailItem,
} from './labels.js';

/** Where a change stands: waiting for an OK, done (undoable), or settled another way. */
export type ChangeStatus =
  'proposed' | 'done' | 'undone' | 'expired' | 'rejected' | 'superseded' | 'refused';

const STATUS: Record<ChangeStatus, { label: string; tone: 'wait' | 'ok' | 'plain' }> = {
  proposed: { label: 'Needs your OK', tone: 'wait' },
  done: { label: 'Done', tone: 'ok' },
  undone: { label: 'Undone', tone: 'plain' },
  expired: { label: 'Expired', tone: 'plain' },
  rejected: { label: 'Turned down', tone: 'plain' },
  superseded: { label: 'Out of date', tone: 'plain' },
  refused: { label: 'Not done', tone: 'plain' },
};

const TONE: Record<'wait' | 'ok' | 'plain', BadgeTone> = {
  wait: 'warn',
  ok: 'ok',
  plain: 'neutral',
};

/** A small status label: always words, never color alone (the kit's Badge). */
export function StatusPill({ label, tone }: { label: string; tone: 'wait' | 'ok' | 'plain' }) {
  return (
    <Badge tone={TONE[tone]} className="shrink-0">
      {label}
    </Badge>
  );
}

export interface ChangeCardProps {
  action: AutonomyAction;
  status: ChangeStatus;
  /** The tool's own sentence (its code's words, never the model's), shown as plain text. */
  summary: string | null;
  before: ChangeSide | null;
  after: ChangeSide | null;
  emails: (EmailItem & { clientId: string })[];
  /** Each emailed client's address the viewer may see (S53): the card says who gets it. */
  recipients?: readonly { clientId: string; address: string }[];
  undoUntil: string | null;
  /** The viewer may approve or reject it (shows the buttons only while `proposed`). */
  canDecide: boolean;
  /** The viewer may undo it (shows Undo only while `done` and the window is open). */
  canUndo: boolean;
  /** "Approved by Ana" on a receipt a lead approved for the viewer. */
  approvedByName?: string | null;
  timeZone: string;
  now: number;
  busy?: boolean;
  /** The outcome of the viewer's last tap, read out politely ("Maria was already emailed"). */
  notice?: string | null;
  onApprove?: () => void;
  onReject?: () => void;
  onUndo?: () => void;
  onWhy?: () => void;
  /** A link to change the dial (the page's own link component). */
  settingsLink?: ReactNode;
  /**
   * What the card shows from memory (S30), read live: the fact a save or forget is about
   * ("Updated: was …"), the booking's warnings (AC-W3-2) and the client's last visit.
   */
  memory?: AiMemoryView | null;
}

/**
 * A change the AI proposed or made (ChangeDiff / Confirmation / receipt, D-1 and D-2): exactly
 * what changes and which emails go, from the domain's dry run. Approve sends only what this card
 * was given (its caller holds the proposal's id and fingerprint); nothing here is model HTML.
 * Buttons are real buttons, so the card works from the keyboard; nothing takes focus by itself.
 * On the kit (S41, DESIGN.md §4): raised while it waits for a decision ("a lifted card means
 * this needs you"), flat with a hairline once settled; the rows are a DetailTable.
 */
export function ChangeCard(props: ChangeCardProps) {
  const headingId = useId();
  const {
    action,
    status,
    summary,
    before,
    after,
    emails,
    timeZone,
    now,
    busy = false,
    notice = null,
  } = props;
  const rows = changeRows(action, before, after);
  const labels = decisionLabels(action, after);
  // A fee the owner waived says so (S68), not "Turned down".
  const pill =
    status === 'rejected' && action === 'payment.no_show_fee'
      ? { label: 'Waived', tone: 'plain' as const }
      : STATUS[status];
  const undoText =
    status === 'done' && props.canUndo ? undoLine(props.undoUntil, timeZone, now) : null;
  const decide = status === 'proposed' && props.canDecide;
  return (
    <article
      aria-labelledby={headingId}
      className={cx(
        'flex max-w-[34rem] flex-col gap-3 rounded-lg bg-surface p-5',
        status === 'proposed' ? 'shadow-raised' : 'border border-line',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="m-0 type-label text-ink-2">
          {ACTION_LABEL[action]}
        </h3>
        <StatusPill {...pill} />
      </div>
      {summary === null || summary === '' ? null : (
        <p className="m-0 type-subheading whitespace-pre-wrap text-ink">{summary}</p>
      )}
      {rows.length === 0 ? null : (
        <DetailTable
          className="border-t border-line"
          rows={rows.map((row) => ({
            label: row.label,
            value: (
              <span className="min-w-0 break-words">
                {row.before === null ? null : (
                  <>
                    <s className="text-ink-2">{row.before}</s>
                    <span className="sr-only"> changes to </span>
                    <span aria-hidden="true"> → </span>
                  </>
                )}
                <span className="font-semibold tabular-nums">{row.after}</span>
              </span>
            ),
          }))}
        />
      )}
      {props.memory === undefined || props.memory === null ? null : (
        <MemoryLines memory={props.memory} />
      )}
      <EmailLines {...props} emails={emails} />
      {props.approvedByName === undefined || props.approvedByName === null ? null : (
        <p className="m-0 type-caption text-ink-2">Approved by {props.approvedByName}.</p>
      )}
      {undoText === null ? null : <p className="m-0 type-caption text-ink-2">{undoText}</p>}
      <p role="status" className="m-0 type-label text-ink empty:hidden">
        {notice}
      </p>
      <div className="flex flex-wrap items-center gap-2 empty:hidden">
        {decide ? (
          <>
            <Button icon="check" busy={busy} onClick={props.onApprove}>
              {labels.approve}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={props.onReject}>
              {labels.reject}
            </Button>
          </>
        ) : null}
        {undoText === null ? null : (
          <Button variant="secondary" size="sm" icon="undo" disabled={busy} onClick={props.onUndo}>
            Undo
          </Button>
        )}
        {props.onWhy === undefined ? null : (
          <Button variant="quiet" size="sm" onClick={props.onWhy}>
            Why?
          </Button>
        )}
      </div>
      {decide &&
      props.settingsLink !== undefined &&
      action !== 'payment.no_show_fee' &&
      action !== 'booking.release' ? (
        <p className="m-0 type-caption text-ink-2">
          Your settings ask me to check with you first. {props.settingsLink}
        </p>
      ) : null}
      {/* Money always asks the owner (S68): no setting to change. */}
      {decide && action === 'payment.no_show_fee' ? (
        <p className="m-0 type-caption text-ink-2">Nothing is charged until you tap.</p>
      ) : null}
      {/* A release always asks and can't be taken back (S78.2, D-5). */}
      {decide && action === 'booking.release' ? (
        <p className="m-0 type-caption text-ink-2">
          Nothing changes until you tap. A release can’t be undone.
        </p>
      ) : null}
    </article>
  );
}

function EmailLines({
  action,
  emails,
  recipients,
  before,
  after,
  timeZone,
  now,
  status,
}: ChangeCardProps) {
  const books = action.startsWith('booking');
  // A release's Then line names its email until it is sent (S78.3 top-up, AC-X-219).
  if (action === 'booking.release' && emails.every((email) => email.status === undefined)) {
    return emails.length === 0 && status !== 'refused' ? (
      <p className="m-0 type-caption text-ink-2">No email to the client.</p>
    ) : null;
  }
  if (emails.length === 0) {
    return books && status !== 'refused' ? (
      <p className="m-0 type-caption text-ink-2">No email to the client.</p>
    ) : null;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 type-label text-ink">
      {emails.map((email, index) => (
        <li key={`${email.clientId}-${String(index)}`}>
          {emailLine(
            email,
            recipientName(
              clientNameFor(email.clientId, before, after),
              recipients?.find((r) => r.clientId === email.clientId)?.address,
            ),
            timeZone,
            now,
          )}
        </li>
      ))}
    </ul>
  );
}

/** "Ana (ana@example.com)": the client and the address the email goes to, when known. */
function recipientName(name: string, address: string | undefined): string {
  return address === undefined ? name : `${name} (${address})`;
}

/** Memory on a card, as plain text (values are people's words, never markup). */
function MemoryLines({ memory }: { memory: AiMemoryView }) {
  const { fact, warnings, lastVisit } = memory;
  return (
    <>
      {warnings.length === 0 ? null : (
        <div role="note" className="flex items-start gap-2 rounded-md bg-warn-soft p-3 type-label">
          <Icon name="alert" className="mt-0.5 text-warn" />
          <div className="flex flex-col gap-1 text-ink">
            <p className="m-0 font-bold">Heads up</p>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {warnings.map((each) => (
                <li key={each.factId} className="whitespace-pre-wrap">
                  {memoryLine(each)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {fact === null ? null : (
        <p className="m-0 type-label whitespace-pre-wrap text-ink">
          {fact.state === 'gone' ? (
            'A fact you deleted'
          ) : (
            <>
              <span className="text-ink-2">{keyWords(fact.key)}: </span>
              <span className="font-semibold">{fact.value}</span>
              {fact.previous === null ? null : (
                <span className="text-ink-2"> (was: {fact.previous})</span>
              )}
            </>
          )}
        </p>
      )}
      {lastVisit === null ? null : (
        <div className="flex flex-col gap-1 type-label text-ink">
          <p className="m-0 text-ink-2">
            Last time ({formatDate(lastVisit.date)}, {lastVisit.serviceName}):
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {lastVisit.notes.map((note) => (
              <li key={note.factId} className="whitespace-pre-wrap">
                {memoryLine(note)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
