'use client';

import type { ImportBatch, ImportBatchId, ImportPreview } from '@pepper/contracts';
import {
  Badge,
  Button,
  buttonStyle,
  Dialog,
  FOCUS_RING,
  List,
  ListRow,
  Receipt,
  Select,
  Skeleton,
  StepBar,
} from '@pepper/ui';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ROUTES } from '../../../lib/account';
import { errorCodeOf } from '../../../lib/client-api';
import {
  ACCEPTED_IMPORT_TYPES,
  clientsHref,
  columnNote,
  commitImport,
  discardImport,
  FIELD_OPTIONS,
  importHref,
  IMPORT_PATH,
  importSteps,
  inProgress,
  loadImport,
  moreRowsNote,
  POLL_LIMIT_MS,
  POLL_MS,
  precheckImport,
  presetName,
  previewSentence,
  remapImport,
  resultSentence,
  rowsToFixFirst,
  stepIndex,
  stepOf,
  undoable,
  undoImport,
  undoQuestion,
  undoUntilLabel,
  uploadImport,
  withField,
  type ImportStep,
} from '../../../lib/imports';
import { RowGroup, TakenTimes } from './import-rows';

/**
 * Bring your clients (S48.2, AC-W1-17…21): pick a file, check the columns, check the clients
 * (the counts in one sentence, the rows to fix first), import, and undo for a week. Nothing
 * reaches the clients until Import; the api re-checks every step. A visits file (S49.2,
 * AC-W1-27…29) brings their history and upcoming appointments the same way, with no email.
 */
export function ImportScreen({
  initial,
  missing,
  timeZone,
}: {
  initial: ImportPreview | null;
  /** A `?batch=` that isn't (or is no longer) an import of this business. */
  missing: boolean;
  timeZone: string;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(initial);
  const [step, setStep] = useState<ImportStep>(stepOf(initial?.batch ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(
    missing ? 'I couldn’t find that import. Pick your file again.' : null,
  );
  const heading = useRef<HTMLHeadingElement>(null);

  // Each step starts at its heading, for a screen reader and a phone scrolled down.
  function go(next: ImportStep) {
    setStep(next);
    setError(null);
    window.scrollTo({ top: 0 });
    heading.current?.focus();
  }

  function show(next: ImportPreview) {
    setPreview(next);
    // The address resumes the import after a refresh (the same screen, no reload).
    window.history.replaceState(null, '', importHref(next.batch.id));
  }

  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  const upload = (file: File) =>
    run(async () => {
      const refused = precheckImport(file);
      if (refused !== null) {
        setError(refused);
        return;
      }
      const answer = await uploadImport(file);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      show(answer.data);
      go('mapping');
    });

  // Started elsewhere (another tab, a double tap): show where it is instead of the stale step.
  async function refused(id: ImportBatchId, answer: { message: string; body?: unknown }) {
    if (errorCodeOf(answer.body) === 'import_not_staged') {
      const current = await loadImport(id);
      if (current.ok) {
        setPreview(current.data);
        go(stepOf(current.data.batch));
        return;
      }
    }
    setError(answer.message);
  }

  const remap = (column: string, field: string) =>
    run(async () => {
      if (preview === null) return;
      const answer = await remapImport(
        preview.batch.id,
        withField(preview.batch.columns, column, field),
      );
      if (!answer.ok) {
        await refused(preview.batch.id, answer);
        return;
      }
      setPreview(answer.data);
    });

  // Back to the start: the staged import is thrown away, without waiting (the api discards
  // one nobody commits after 24 h anyway).
  function startOver() {
    if (busy) return;
    if (preview?.batch.status === 'staged') void discardImport(preview.batch.id);
    setPreview(null);
    window.history.replaceState(null, '', IMPORT_PATH);
    go('upload');
  }

  const commit = () =>
    run(async () => {
      if (preview === null) return;
      const answer = await commitImport(preview.batch.id);
      if (!answer.ok) {
        await refused(preview.batch.id, answer);
        return;
      }
      setPreview({ batch: answer.data, rows: [] });
      go('result');
    });

  return (
    // Room at the end for the phone's fixed action bar.
    <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-20 desk:pb-0">
      <header className="flex flex-col gap-3">
        <Link
          href={ROUTES.clients}
          className={`-ml-2 inline-flex min-h-11 items-center self-start rounded-pill px-2 type-label text-brand ${FOCUS_RING}`}
        >
          <span aria-hidden="true">‹&nbsp;</span>Clients
        </Link>
        <h1 ref={heading} tabIndex={-1} className="m-0 type-display outline-none">
          Bring your clients
        </h1>
        <StepBar
          steps={importSteps(preview?.batch.kind ?? 'clients')}
          current={stepIndex(step)}
          label="Import steps"
        />
      </header>
      {error === null ? null : (
        <p
          role="alert"
          className="m-0 rounded-md bg-danger-soft px-4 py-3 type-body text-danger"
          data-testid="import-error"
        >
          {error}
        </p>
      )}
      {step === 'upload' || preview === null ? (
        <UploadStep busy={busy} onFile={(file) => void upload(file)} />
      ) : step === 'mapping' ? (
        <MappingStep
          batch={preview.batch}
          busy={busy}
          onChange={(column, field) => void remap(column, field)}
          onBack={startOver}
          onNext={() => {
            go('preview');
          }}
        />
      ) : step === 'preview' ? (
        <PreviewStep
          preview={preview}
          timeZone={timeZone}
          busy={busy}
          onBack={() => {
            go('mapping');
          }}
          onImport={() => void commit()}
        />
      ) : (
        <ResultStep
          preview={preview}
          timeZone={timeZone}
          onChange={setPreview}
          onAgain={() => {
            setPreview(null);
            window.history.replaceState(null, '', IMPORT_PATH);
            go('upload');
          }}
        />
      )}
    </div>
  );
}

/**
 * The step's Back and its one main action: on a phone fixed above the tabs, within thumb reach
 * however short the step (D3); on a desktop at the end of the step, kept in view.
 */
function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-[calc(var(--spacing-tab-bar)+env(safe-area-inset-bottom))] z-10 border-t border-line bg-bg px-5 py-3 desk:sticky desk:bottom-0 desk:px-0"
      data-testid="import-actions"
    >
      <div className="mx-auto flex max-w-2xl items-center justify-end gap-3">{children}</div>
    </div>
  );
}

function UploadStep({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-upload">
        <h2 id="import-upload" className="m-0 type-heading">
          Pick your clients or appointments
        </h2>
        <p className="m-0 type-body text-ink-2">
          Export your client list, or your appointments, from the app you use now (Square, Booksy,
          Vagaro, GlossGenius, Fresha or any other) as a CSV or JSON file, then pick it here. I’ll
          match the columns and show you everything before anything changes.
        </p>
        <List label="What happens">
          <ListRow
            title="Nothing changes until you say Import"
            meta="You see every client and visit first."
          />
          <ListRow
            title="No one is added twice"
            meta="Clients already here only get the email or phone they’re missing."
          />
          <ListRow
            title="No one gets an email"
            meta="Appointments come in quietly: no confirmations, no reminders."
          />
          <ListRow title="Undo for 7 days" meta="One tap takes the whole import back out." />
        </List>
        <p className="m-0 type-caption text-ink-2">Up to 10,000 rows and 5 MB per file.</p>
      </section>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_IMPORT_TYPES}
        hidden
        data-testid="import-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file !== undefined) onFile(file);
        }}
      />
      <ActionBar>
        <Button block disabled={busy} onClick={() => input.current?.click()}>
          {busy ? 'Reading your file…' : 'Pick a file'}
        </Button>
      </ActionBar>
    </>
  );
}

function MappingStep({
  batch,
  busy,
  onChange,
  onBack,
  onNext,
}: {
  batch: ImportBatch;
  busy: boolean;
  onChange: (column: string, field: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-mapping">
        <h2 id="import-mapping" className="m-0 type-heading">
          Check the columns
        </h2>
        <p className="m-0 type-body text-ink-2" data-testid="import-preset">
          {batch.preset === null
            ? 'I matched each column of your file by its name and what’s in it. Change any that’s off.'
            : `This looks like a ${presetName(batch.preset)} export, so I matched its columns. Change any that’s off.`}
        </p>
        <Problems problems={batch.problems} />
        <ul className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Columns of your file">
          {batch.columns.map((column) => (
            <li key={column.column} data-testid="import-column">
              <Select
                label={column.column}
                hint={columnNote(column, batch.preset)}
                value={column.field ?? ''}
                disabled={busy}
                options={FIELD_OPTIONS}
                onChange={(event) => {
                  onChange(column.column, event.target.value);
                }}
              />
            </li>
          ))}
        </ul>
      </section>
      <ActionBar>
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          Another file
        </Button>
        <Button disabled={busy} onClick={onNext}>
          Check the {batch.kind}
        </Button>
      </ActionBar>
    </>
  );
}

function Problems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Fix the columns first">
      {problems.map((problem) => (
        <li
          key={problem}
          className="flex items-start gap-2 rounded-md bg-warn-soft px-4 py-3 type-body text-ink"
          data-testid="import-problem"
        >
          <Badge tone="warn">Fix</Badge>
          <span>{problem}</span>
        </li>
      ))}
    </ul>
  );
}

/** What the owner should know that doesn't stop the import (a hidden service it brings). */
function Notices({ notices }: { notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Good to know">
      {notices.map((notice) => (
        <li
          key={notice}
          className="flex items-start gap-2 rounded-md bg-surface-2 px-4 py-3 type-body text-ink"
          data-testid="import-notice"
        >
          <Badge tone="info">Note</Badge>
          <span>{notice}</span>
        </li>
      ))}
    </ul>
  );
}

function PreviewStep({
  preview,
  timeZone,
  busy,
  onBack,
  onImport,
}: {
  preview: ImportPreview;
  timeZone: string;
  busy: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const { batch, rows } = preview;
  const visits = batch.kind === 'visits';
  const { toFix, taken, leftOut, rest } = rowsToFixFirst(rows);
  // A visits file's `create` is its visits; a client file's, with `merge`, its clients.
  const importing = visits ? batch.counts.create : batch.counts.create + batch.counts.merge;
  const blocked = batch.problems.length > 0 || importing === 0;
  const more = moreRowsNote(batch.counts, rows);
  const [one, many] = visits ? (['visit', 'visits'] as const) : (['client', 'clients'] as const);
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-preview">
        <h2 id="import-preview" className="sr-only">
          Check the {batch.kind}
        </h2>
        <p className="m-0 type-title text-ink tabular-nums" data-testid="import-sentence">
          {previewSentence(batch.counts, batch.kind)}
        </p>
        <p className="m-0 type-body text-ink-2">
          {toFix.length > 0
            ? 'The rows to fix are left out. Fix them in your file and pick it again, or import the rest now.'
            : visits
              ? 'Nothing is written until you tap Import, and no one gets an email.'
              : 'Nothing is written until you tap Import.'}
        </p>
        <Problems problems={batch.problems} />
        <Notices notices={batch.notices} />
      </section>
      <RowGroup title="To fix" rows={toFix} testId="import-fix" timeZone={timeZone} />
      <RowGroup title="Times taken" rows={taken} testId="import-conflict" timeZone={timeZone} />
      <RowGroup title="Left out" rows={leftOut} testId="import-skipped" timeZone={timeZone} />
      <RowGroup title="Ready to import" rows={rest} testId="import-ready" timeZone={timeZone} />
      {more === null ? null : <p className="m-0 type-caption text-ink-2 tabular-nums">{more}</p>}
      <ActionBar>
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          Columns
        </Button>
        <Button disabled={busy || blocked} onClick={onImport}>
          {busy
            ? 'Importing…'
            : importing === 0
              ? 'Nothing to import'
              : `Import ${String(importing)} ${importing === 1 ? one : many}`}
        </Button>
      </ActionBar>
    </>
  );
}

function ResultStep({
  preview,
  timeZone,
  onChange,
  onAgain,
}: {
  preview: ImportPreview;
  timeZone: string;
  onChange: (preview: ImportPreview) => void;
  onAgain: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const { batch, rows } = preview;
  const running = inProgress(batch);
  const what = batch.kind === 'visits' ? 'visits' : 'clients';

  // While the worker runs: ask again every POLL_MS, and stop asking after POLL_LIMIT_MS.
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    let stopped = false;
    // Read through a call, so a check after an await sees the cleanup's change.
    const ended = () => stopped;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = async () => {
      if (ended()) return;
      if (Date.now() - started > POLL_LIMIT_MS) {
        setStalled(true);
        return;
      }
      const answer = await loadImport(batch.id);
      if (ended()) return;
      if (answer.ok) onChange(answer.data);
      if (!answer.ok || inProgress(answer.data.batch))
        timer = setTimeout(() => void ask(), POLL_MS);
    };
    timer = setTimeout(() => void ask(), POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [running, batch.id, onChange]);

  async function undo() {
    if (undoing) return;
    setUndoing(true);
    setError(null);
    const answer = await undoImport(batch.id);
    setUndoing(false);
    setConfirming(false);
    if (!answer.ok) {
      setError(answer.message);
      return;
    }
    onChange({ batch: answer.data, rows: [] });
  }

  const until = undoUntilLabel(batch, timeZone);
  const canUndo = undoable(batch, new Date());
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-result">
        <h2 id="import-result" className="m-0 type-heading">
          {running
            ? `Importing your ${what}`
            : batch.status === 'undone'
              ? 'Import undone'
              : batch.status === 'failed'
                ? 'The import stopped'
                : `Your ${what} are in`}
        </h2>
        {running ? (
          <div className="flex flex-col gap-3" role="status" data-testid="import-result">
            <p className="m-0 type-body text-ink tabular-nums">{resultSentence(batch)}</p>
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
            {stalled ? (
              <p className="m-0 type-body text-ink-2">
                This is taking longer than usual. Come back in a few minutes.
              </p>
            ) : null}
          </div>
        ) : batch.status === 'done' && canUndo && until !== null ? (
          <div data-testid="import-result">
            <Receipt
              undo={{
                onUndo: () => {
                  setConfirming(true);
                },
                until,
              }}
            >
              <span className="tabular-nums">{resultSentence(batch)}</span> You can undo it until{' '}
              <span data-testid="import-undo-until">{until}</span>.
            </Receipt>
          </div>
        ) : (
          <p
            className={`m-0 rounded-md px-4 py-3 type-body tabular-nums ${batch.status === 'failed' ? 'bg-warn-soft text-ink' : 'bg-surface-2 text-ink'}`}
            role="status"
            data-testid="import-result"
          >
            {resultSentence(batch)}
          </p>
        )}
        {batch.status === 'failed' && canUndo ? (
          <Button
            variant="secondary"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Undo what it added
          </Button>
        ) : null}
        {error === null ? null : (
          <p role="alert" className="m-0 type-body font-semibold text-danger">
            {error}
          </p>
        )}
      </section>
      <TakenTimes batch={batch} rows={rows} timeZone={timeZone} />
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Undo this import?"
        description={undoQuestion(batch.counts, batch.kind)}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep them
            </Button>
            <Button variant="danger" disabled={undoing} onClick={() => void undo()}>
              {undoing ? 'Undoing…' : 'Undo import'}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
      {running ? null : (
        <ActionBar>
          {batch.status === 'undone' ? (
            <Button block onClick={onAgain}>
              Import a file
            </Button>
          ) : (
            <Link
              href={clientsHref(batch)}
              className={buttonStyle({ variant: 'primary', block: true })}
              data-testid="import-see-clients"
            >
              See your clients
            </Link>
          )}
        </ActionBar>
      )}
    </>
  );
}
