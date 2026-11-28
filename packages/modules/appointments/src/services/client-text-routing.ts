import { formatDate, toZoned, type ClientTextReading } from '@pepper/contracts';

// What a client's text leads to (S81a.2, ADR-0073; AC-X-243…246). The model only reads the text;
// this decides. Only a sure reading acts, and only on a visit from the list the domain built for
// the kept text's own client. Anything else ends at the owner's card, which shows every text.

/** One of the client's visits, as the domain found them for the kept text (never the model). */
export interface RoutableVisit {
  bookingId: string;
  staffMemberId: string;
  serviceId: string;
  startsAt: Date;
}

/** Why a text was left to the owner's card. */
export type CardReason =
  /** The reader wasn't sure, refused, or had no budget. */
  | 'not_sure'
  /** A question or something else: a person answers. */
  | 'no_action'
  /** More than one visit fits and the text names none. */
  | 'which_visit'
  /** No coming visit fits (or none today for a client running late). */
  | 'no_visit';

export type ClientTextRoute =
  | { kind: 'confirm'; visit: RoutableVisit }
  | { kind: 'late'; visit: RoutableVisit; minutesLate: number | null }
  | { kind: 'cancel'; visit: RoutableVisit }
  | {
      kind: 'move';
      visit: RoutableVisit;
      askedFor: { date: string | null; time: string | null } | null;
    }
  | { kind: 'card'; reason: CardReason };

/**
 * The route of one read text (AC-X-246). `reading` is `null` when the reader refused or had no
 * budget; `now` is when the job runs (a retried job never acts on a visit that has since started).
 * A reading's visit must be one of `visits`; with none named, the only visit, else the only one
 * today, is the one meant; a client running late is only ever late for one today. A confirm,
 * cancel or move is only for a visit still to come.
 */
export function routeClientText(input: {
  reading: ClientTextReading | null;
  visits: readonly RoutableVisit[];
  now: Date;
  timeZone: string;
}): ClientTextRoute {
  const { reading, now, timeZone } = input;
  if (reading?.confidence !== 'sure') return { kind: 'card', reason: 'not_sure' };
  if (reading.intent === 'question' || reading.intent === 'other') {
    return { kind: 'card', reason: 'no_action' };
  }
  const today = formatDate(toZoned(timeZone, now.getTime()));
  const isToday = (visit: RoutableVisit) =>
    formatDate(toZoned(timeZone, visit.startsAt.getTime())) === today;
  const late = reading.intent === 'running_late';
  let visit: RoutableVisit | undefined;
  if (reading.visitId !== null) {
    visit = input.visits.find((candidate) => candidate.bookingId === reading.visitId);
  } else {
    // None named: every visit the reader was shown counts (one that just started too), so a text
    // that may be about either asks which rather than landing on the next one.
    const pool = late ? input.visits.filter(isToday) : input.visits;
    if (pool.length > 1) {
      const todays = pool.filter(isToday);
      if (todays.length !== 1) return { kind: 'card', reason: 'which_visit' };
      visit = todays[0];
    } else {
      visit = pool[0];
    }
  }
  // Running late is about a visit today, which may have just started; the rest about one to come.
  if (visit === undefined || !(late ? isToday(visit) : visit.startsAt.getTime() > now.getTime())) {
    return { kind: 'card', reason: 'no_visit' };
  }
  switch (reading.intent) {
    case 'confirm':
      return { kind: 'confirm', visit };
    case 'running_late':
      return { kind: 'late', visit, minutesLate: reading.minutesLate };
    case 'cancel':
      return { kind: 'cancel', visit };
    case 'reschedule':
      return { kind: 'move', visit, askedFor: reading.askedFor };
  }
}
