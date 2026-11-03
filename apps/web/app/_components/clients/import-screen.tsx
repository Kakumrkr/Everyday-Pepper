'use client';

import type { ImportBatch, ImportPreview, ImportRow } from '@pepper/contracts';
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
import {
  ACCEPTED_IMPORT_TYPES,
  columnNote,
  commitImport,
  discardImport,
  FIELD_OPTIONS,
  importHref,
  IMPORT_PATH,
  IMPORT_STEPS,
  inProgress,
  loadImport,
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
  undoUntilLabel,
  uploadImport,
  withField,
  type ImportStep,
} from '../../../lib/imports';

/**
 * Bring your clients (S48.2, AC-W1-17…21): pick a file, check the columns, check the clients
 * (the counts in one sentence, the rows to fix first), import, and undo for a week. Nothing
 * reaches the clients until Import; the api re-checks every step.
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

  const remap = (column: string, field: string) =>
    run(async () => {
      if (preview === null) return;
      const answer = await remapImport(
        preview.batch.id,
        withField(preview.batch.columns, column, field),
      );
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      setPreview(answer.data);
    });

  // Back to the start: the staged import is thrown away (the api discards it after 24 h anyway).
  const startOver = () =>
    run(async () => {
      if (preview?.batch.status === 'staged') await discardImport(preview.batch.id);
      setPreview(null);
      window.history.replaceState(null, '', IMPORT_PATH);
      go('upload');
    });

  const commit = () =>
    run(async () => {
      if (preview === null) return;
      const answer = await commitImport(preview.batch.id);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      setPreview({ batch: answer.data, rows: [] });
      go('result');
    });

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
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
        <StepBar steps={IMPORT_STEPS} current={stepIndex(step)} label="Import steps" />
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
          onBack={() => void startOver()}
          onNext={() => {
            go('preview');
          }}
        />
      ) : step === 'preview' ? (
        <PreviewStep
          preview={preview}
          busy={busy}
          onBack={() => {
            go('mapping');
          }}
          onImport={() => void commit()}
        />
      ) : (
        <ResultStep
          batch={preview.batch}
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

/** The step's Back and its one main action, above the tabs within thumb reach (D3). */
function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div
      className="sticky bottom-[calc(var(--spacing-tab-bar)+env(safe-area-inset-bottom))] -mx-5 flex items-center justify-end gap-3 border-t border-line bg-bg px-5 py-3 desk:bottom-0 desk:mx-0 desk:px-0"
      data-testid="import-actions"
    >
      {children}
    </div>
  );
}

function UploadStep({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-upload">
        <h2 id="import-upload" className="m-0 type-heading">
          Pick your client list
        </h2>
        <p className="m-0 type-body text-ink-2">
          Export your clients from the app you use now (Square, Booksy, Vagaro, GlossGenius, Fresha
          or any other) as a CSV or JSON file, then pick it here. I’ll match the columns and show
          you every client before anything changes.
        </p>
        <List label="What happens">
          <ListRow
            title="Nothing changes until you say Import"
            meta="You see every client first."
          />
          <ListRow
            title="No one is added twice"
            meta="Clients already here only get the email or phone they’re missing."
          />
          <ListRow title="Undo for 7 days" meta="One tap takes the whole import back out." />
        </List>
        <p className="m-0 type-caption text-ink-2">Up to 10,000 clients and 5 MB per file.</p>
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
          Check the clients
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

function PreviewStep({
  preview,
  busy,
  onBack,
  onImport,
}: {
  preview: ImportPreview;
  busy: boolean;
  onBack: () => void;
  onImport: () => void;
}) {
  const { batch, rows } = preview;
  const { toFix, leftOut, rest } = rowsToFixFirst(rows);
  const importing = batch.counts.create + batch.counts.merge;
  const blocked = batch.problems.length > 0 || importing === 0;
  return (
    <>
      <section className="flex flex-col gap-3" aria-labelledby="import-preview">
        <h2 id="import-preview" className="sr-only">
          Check the clients
        </h2>
        <p className="m-0 type-title text-ink tabular-nums" data-testid="import-sentence">
          {previewSentence(batch.counts)}
        </p>
        <p className="m-0 type-body text-ink-2">
          {toFix.length > 0
            ? 'The rows to fix are left out. Fix them in your file and pick it again, or import the rest now.'
            : 'Nothing is written until you tap Import.'}
        </p>
        <Problems problems={batch.problems} />
      </section>
      <RowGroup title="To fix" rows={toFix} testId="import-fix" />
      <RowGroup title="Left out" rows={leftOut} testId="import-skipped" />
      <RowGroup title="Ready to import" rows={rest} testId="import-ready" />
      {rows.length < batch.counts.rows ? (
        <p className="m-0 type-caption text-ink-2 tabular-nums">
          Showing {rows.length} of {batch.counts.rows} rows. The rest import the same way.
        </p>
      ) : null}
      <ActionBar>
        <Button variant="secondary" disabled={busy} onClick={onBack}>
          Columns
        </Button>
        <Button disabled={busy || blocked} onClick={onImport}>
          {busy
            ? 'Importing…'
            : importing === 0
              ? 'Nothing to import'
              : `Import ${String(importing)} ${importing === 1 ? 'client' : 'clients'}`}
        </Button>
      </ActionBar>
    </>
  );
}

function RowGroup({ title, rows, testId }: { title: string; rows: ImportRow[]; testId: string }) {
  if (rows.length === 0) return null;
  const id = `${testId}-heading`;
  return (
    <section className="flex flex-col gap-2" aria-labelledby={id}>
      <h3 id={id} className="m-0 type-subheading text-ink tabular-nums">
        {title} · {rows.length}
      </h3>
      <List>
        {rows.map((row) => (
          <li key={row.row} data-testid={testId}>
            <RowLine row={row} />
          </li>
        ))}
      </List>
    </section>
  );
}

const OUTCOME_BADGES: Record<
  ImportRow['outcome'],
  { label: string; tone: 'ok' | 'info' | 'warn' | 'neutral' }
> = {
  create: { label: 'New', tone: 'ok' },
  merge: { label: 'Fills in', tone: 'info' },
  unchanged: { label: 'Already here', tone: 'neutral' },
  invalid: { label: 'Fix', tone: 'warn' },
  skipped: { label: 'Left out', tone: 'neutral' },
};

/** A row of the file: where it is, who it is, and what to fix or what it does. */
function RowLine({ row }: { row: ImportRow }) {
  const badge = OUTCOME_BADGES[row.outcome];
  const contact = [row.email, row.phone].filter((part) => part !== null).join(' · ');
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="w-14 shrink-0 type-caption text-ink-2 tabular-nums">Row {row.row}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="type-body font-semibold break-words text-ink">
          {row.name ?? 'No name'}
        </span>
        {contact === '' ? null : (
          <span className="type-caption break-words text-ink-2">{contact}</span>
        )}
        {row.reasons.map((reason) => (
          <span key={reason.code} className="type-body text-ink">
            {reason.message}
          </span>
        ))}
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

function ResultStep({
  batch,
  timeZone,
  onChange,
  onAgain,
}: {
  batch: ImportBatch;
  timeZone: string;
  onChange: (preview: ImportPreview) => void;
  onAgain: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const running = inProgress(batch);

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
            ? 'Importing your clients'
            : batch.status === 'undone'
              ? 'Import undone'
              : batch.status === 'failed'
                ? 'The import stopped'
                : 'Your clients are in'}
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
              {until}.
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
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Undo this import?"
        description={`I’ll remove the ${String(batch.counts.create)} clients it added and clear the emails and phones it filled in. Anyone who booked since stays.`}
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
              href={ROUTES.clients}
              className={buttonStyle({ variant: 'primary', block: true })}
            >
              See your clients
            </Link>
          )}
        </ActionBar>
      )}
    </>
  );
}
