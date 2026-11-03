import type { ImportBatch, ImportRow } from '@pepper/contracts';
import { Badge, buttonStyle, List } from '@pepper/ui';
import Link from 'next/link';
import { formatPhone } from '../../../lib/booking-profile';
import {
  bookAgainHref,
  count,
  rowBadge,
  takenTimes,
  visitLine,
  type BookAgainChoices,
} from '../../../lib/imports';

/** A group of the preview's rows under its heading and count; nothing when it has none. */
export function RowGroup({
  title,
  rows,
  testId,
  timeZone,
}: {
  title: string;
  rows: ImportRow[];
  testId: string;
  timeZone: string;
}) {
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
            <RowLine row={row} timeZone={timeZone} />
          </li>
        ))}
      </List>
    </section>
  );
}

/**
 * A row of the file: where it is, who it is, its visit (a visits file's, AC-W1-27), and what to
 * fix or what it does.
 */
function RowLine({ row, timeZone }: { row: ImportRow; timeZone: string }) {
  const badge = rowBadge(row);
  const contact = [row.email, row.phone === null ? null : formatPhone(row.phone)]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="w-14 shrink-0 type-caption text-ink-2 tabular-nums">Row {row.row}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="type-body font-semibold break-words text-ink">
          {row.name ?? 'No name'}
        </span>
        {row.visit === null ? null : (
          <span
            className="type-caption break-words text-ink tabular-nums"
            data-testid="import-visit"
          >
            {visitLine(row.visit, timeZone)}
          </span>
        )}
        {contact === '' ? null : (
          <span className="type-caption break-words text-ink-2">{contact}</span>
        )}
        {row.reasons.map((reason, index) => (
          // By position: a row may have the same reason twice (two bad phone columns).
          <span key={index} className="type-body text-ink">
            {reason.message}
          </span>
        ))}
      </div>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

/**
 * The upcoming visits a run left out because their time was taken (AC-W1-29, the S49 retro
 * top-up): each with its client and time, and "Book again": the client's profile with Book open
 * on the visit's service and staff member (S50, AC-W1-33). So a client with a standing appointment isn't forgotten.
 */
export function TakenTimes({
  batch,
  rows,
  timeZone,
  choices,
}: {
  batch: ImportBatch;
  rows: readonly ImportRow[];
  timeZone: string;
  /** What "Book again" may preselect (AC-W1-33). */
  choices: BookAgainChoices;
}) {
  const taken = takenTimes(batch, rows);
  if (taken.rows.length === 0 && taken.more === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="import-taken-heading">
      <h3 id="import-taken-heading" className="m-0 type-subheading text-ink">
        Book these again
      </h3>
      <p className="m-0 type-body text-ink-2">
        Someone else had these times in your calendar, so I left them out. Find each client a new
        time.
      </p>
      {taken.rows.length === 0 ? null : (
        <List label="Times taken">
          {taken.rows.map((row) => (
            <li key={row.row} className="flex items-center gap-3 py-3" data-testid="import-taken">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="type-body font-semibold break-words text-ink">
                  {row.name ?? 'No name'}
                </span>
                {row.visit === null ? null : (
                  <span className="type-caption break-words text-ink-2 tabular-nums">
                    {visitLine(row.visit, timeZone)}
                  </span>
                )}
              </div>
              {row.clientId === null ? null : (
                <Link
                  href={bookAgainHref(row.clientId, row.visit, choices)}
                  className={buttonStyle({ variant: 'secondary', size: 'sm' })}
                >
                  Book again
                  {/* The visible words first, so a voice command "Book again" finds it. */}
                  <span className="sr-only">: {row.name ?? 'this client'}</span>
                </Link>
              )}
            </li>
          ))}
        </List>
      )}
      {taken.more === 0 ? null : (
        <p className="m-0 type-caption text-ink-2 tabular-nums">
          {count(taken.more, 'more time was', 'more times were')} taken: you’ll find them in your
          file.
        </p>
      )}
    </section>
  );
}
