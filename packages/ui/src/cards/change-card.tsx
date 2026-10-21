import type { AutonomyAction, ChangeSide } from '@pepper/contracts';
import { useId, type ReactNode } from 'react';
import { buttonClass, cx } from '../class-names.js';
import { Icon } from '../icons.js';
import {
  ACTION_LABEL,
  changeRows,
  clientNameFor,
  emailLine,
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

const PILL: Record<'wait' | 'ok' | 'plain', string> = {
  wait: 'bg-wait-soft text-wait',
  ok: 'bg-ok-soft text-ok',
  plain: 'bg-surface-2 text-ink-2',
};

/** A small status label: always words, never color alone. */
export function StatusPill({ label, tone }: { label: string; tone: 'wait' | 'ok' | 'plain' }) {
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-xs font-bold',
        PILL[tone],
      )}
    >
      {label}
    </span>
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
}

/**
 * A change the AI proposed or made (ChangeDiff / Confirmation / receipt, D-1 and D-2): exactly
 * what changes and which emails go, from the domain's dry run. Approve sends only what this card
 * was given (its caller holds the proposal's id and fingerprint); nothing here is model HTML.
 * Buttons are real buttons, so the card works from the keyboard; nothing takes focus by itself.
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
  const pill = STATUS[status];
  const undoText =
    status === 'done' && props.canUndo ? undoLine(props.undoUntil, timeZone, now) : null;
  const decide = status === 'proposed' && props.canDecide;
  return (
    <article
      aria-labelledby={headingId}
      className="flex max-w-[34rem] flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className="m-0 text-xs font-bold tracking-wide text-ink-2 uppercase">
          {ACTION_LABEL[action]}
        </h3>
        <StatusPill {...pill} />
      </div>
      {summary === null || summary === '' ? null : (
        <p className="m-0 font-semibold whitespace-pre-wrap">{summary}</p>
      )}
      {rows.length === 0 ? null : (
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-ink-2">{row.label}</dt>
              <dd className="m-0 min-w-0">
                {row.before === null ? null : (
                  <>
                    <s className="text-ink-2">{row.before}</s>
                    <span className="sr-only"> changes to </span>
                    <span aria-hidden="true"> → </span>
                  </>
                )}
                <span className="font-semibold">{row.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <EmailLines {...props} emails={emails} />
      {props.approvedByName === undefined || props.approvedByName === null ? null : (
        <p className="m-0 text-sm text-ink-2">Approved by {props.approvedByName}.</p>
      )}
      {undoText === null ? null : <p className="m-0 text-sm text-ink-2">{undoText}</p>}
      <p role="status" className="m-0 text-sm font-semibold empty:hidden">
        {notice}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {decide ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={props.onApprove}
              className={buttonClass({ size: 'sm' })}
            >
              <Icon name="check" />
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={props.onReject}
              className={buttonClass({ variant: 'secondary', size: 'sm' })}
            >
              Not now
            </button>
          </>
        ) : null}
        {undoText === null ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={props.onUndo}
            className={buttonClass({ variant: 'secondary', size: 'sm' })}
          >
            <Icon name="undo" />
            Undo
          </button>
        )}
        {props.onWhy === undefined ? null : (
          <button
            type="button"
            onClick={props.onWhy}
            className={buttonClass({ variant: 'quiet', size: 'sm' })}
          >
            Why?
          </button>
        )}
      </div>
      {decide && props.settingsLink !== undefined ? (
        <p className="m-0 text-xs text-ink-2">
          Your settings ask me to check with you first. {props.settingsLink}
        </p>
      ) : null}
    </article>
  );
}

function EmailLines({ action, emails, before, after, timeZone, now, status }: ChangeCardProps) {
  const books = action.startsWith('booking');
  if (emails.length === 0) {
    return books && status !== 'refused' ? (
      <p className="m-0 text-sm text-ink-2">No email to the client.</p>
    ) : null;
  }
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-sm">
      {emails.map((email, index) => (
        <li key={`${email.clientId}-${String(index)}`}>
          {emailLine(email, clientNameFor(email.clientId, before, after), timeZone, now)}
        </li>
      ))}
    </ul>
  );
}
