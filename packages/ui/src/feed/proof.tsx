import type { EveningWrap as EveningWrapNumbers, WeekValue } from '@pepper/contracts';
import { useId } from 'react';
import { List, ListRow } from '../kit/blocks.js';
import { MoneyChip } from '../kit/marks.js';
import { clockTime, formatDuration } from './feed-lines.js';

// Proof of value on Home (S55, ADR-0058; AC-W4-10…12): what Pepper did this week and, in the
// evening, tomorrow. Flat hairline blocks, not raised cards: nothing here needs a decision
// (DESIGN.md §2). The words are written here from the numbers, never by the model.

const count = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/** The time saved as the card says it: rounded to 5 minutes. */
const shownMinutes = (week: WeekValue) => Math.round(week.minutesSaved / 5) * 5;

/** Pepper did something this week worth showing (else the card stays away, AC-W4-13). */
export function weekHasProof(week: WeekValue): boolean {
  return week.visitsBooked > 0 || shownMinutes(week) > 0;
}

/** The week card's rows, the zeros left out; the time saved rounded to 5 minutes. */
export function weekLines(week: WeekValue): {
  title: string;
  rows: { key: string; title: string; cents: number | null }[];
  saved: string | null;
} {
  const rows: { key: string; title: string; cents: number | null }[] = [];
  if (week.visitsBooked > 0) {
    rows.push({
      key: 'visits',
      title: `${count(week.visitsBooked, 'visit')} booked through me`,
      cents: week.valueCents > 0 ? week.valueCents : null,
    });
  }
  if (week.gapsFilled > 0) {
    rows.push({
      key: 'gaps',
      title: `${count(week.gapsFilled, 'freed time')} filled`,
      cents: null,
    });
  }
  if (week.regularsBack > 0) {
    rows.push({
      key: 'regulars',
      title: `${count(week.regularsBack, 'regular')} back after my email`,
      cents: week.regularsBackCents > 0 ? week.regularsBackCents : null,
    });
  }
  const minutes = shownMinutes(week);
  return {
    title: 'What I did this week',
    rows,
    saved: minutes > 0 ? `About ${formatDuration(minutes)} of your time saved.` : null,
  };
}

export interface WeekProofProps {
  week: WeekValue;
}

/** "What I did this week": the visits, the fills, the regulars back, the dollars, the time. */
export function WeekProof({ week }: WeekProofProps) {
  const headingId = useId();
  if (!weekHasProof(week)) return null;
  const words = weekLines(week);
  return (
    <section aria-labelledby={headingId} data-testid="week-proof" className="flex flex-col gap-1">
      <h2 id={headingId} className="m-0 type-heading">
        {words.title}
      </h2>
      {words.rows.length === 0 ? null : (
        <List>
          {words.rows.map((row) => (
            <ListRow
              key={row.key}
              title={row.title}
              trailing={row.cents === null ? undefined : <MoneyChip cents={row.cents} />}
            />
          ))}
        </List>
      )}
      {words.saved === null ? null : <p className="m-0 type-body text-ink-2">{words.saved}</p>}
    </section>
  );
}

/** The evening wrap's words: tomorrow's count from its first time, then who is at risk. */
export function eveningLines(
  evening: EveningWrapNumbers,
  timeZone: string,
): { title: string; atRisk: { key: string; title: string; meta: string }[]; more: string | null } {
  const title =
    evening.visitCount === 0 || evening.firstStartsAt === null
      ? 'Tomorrow: nothing booked yet'
      : `Tomorrow: ${count(evening.visitCount, 'visit')}, the first at ${clockTime(evening.firstStartsAt, timeZone)}`;
  const named = evening.atRisk.length;
  return {
    title,
    atRisk: evening.atRisk.map((visit) => ({
      key: visit.bookingId,
      title: visit.clientName,
      meta: `${clockTime(visit.startsAt, timeZone)} · missed ${String(visit.noShowCount)} visits in 6 months`,
    })),
    more:
      evening.atRiskCount > named
        ? `And ${count(evening.atRiskCount - named, 'more visit')} at risk.`
        : null,
  };
}

export interface EveningWrapProps {
  /** Tomorrow, or `null` before the evening hour (nothing shows). */
  evening: EveningWrapNumbers | null;
  timeZone: string;
}

/** "Tomorrow: 7 visits, the first at 9:00 am", and the visits at risk of a no-show. */
export function EveningWrap({ evening, timeZone }: EveningWrapProps) {
  const headingId = useId();
  if (evening === null) return null;
  const words = eveningLines(evening, timeZone);
  return (
    <section
      aria-labelledby={headingId}
      data-testid="evening-wrap"
      className="flex flex-col gap-1 rounded-xl bg-surface-2 p-5"
    >
      <h2 id={headingId} className="m-0 type-heading">
        {words.title}
      </h2>
      {evening.atRiskCount === 0 ? (
        evening.visitCount === 0 ? null : (
          <p className="m-0 type-body text-ink-2">Nobody booked has missed visits lately.</p>
        )
      ) : (
        <>
          <p className="m-0 type-body text-ink-2">
            {count(evening.atRiskCount, 'visit')} at risk of a no-show.
          </p>
          <List label="Visits at risk">
            {words.atRisk.map((row) => (
              <ListRow key={row.key} title={row.title} meta={row.meta} />
            ))}
          </List>
          {words.more === null ? null : <p className="m-0 type-caption text-ink-2">{words.more}</p>}
        </>
      )}
    </section>
  );
}
