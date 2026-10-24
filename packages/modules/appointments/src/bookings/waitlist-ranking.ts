import { minutesOfDay, type WaitlistWindow } from '@pepper/contracts';
import { fromZoned, parseDate } from '../availability/zoned-time.js';

// The smart waitlist's ranking (S37, ADR-0041, playbook principle 10), a published formula the
// offer's *Why?* repeats: of the entries whose windows hold the freed time (and whose service
// the freed staff member can do then, which the caller checks with the availability engine),
// first those who asked for this staff member over those who take anyone, then who has waited
// longest, then who has visited most. Ties go to the entry id, so a ranking never depends on
// the order rows came back in.

const MINUTE_MS = 60_000;

/** How well an entry fits the freed slot: it named this staff member, or takes anyone. */
export type WaitlistFit = 'asked_for_staff' | 'anyone';

export interface WaitlistCandidate {
  entryId: string;
  /** The staff member the entry names, or `null` for anyone. */
  staffMemberId: string | null;
  /** When the client joined the list. */
  createdAt: Date;
  /** Their completed visits. */
  visits: number;
}

export interface RankedCandidate<C extends WaitlistCandidate> {
  candidate: C;
  fit: WaitlistFit;
  /** 1 for the best. */
  rank: number;
}

/**
 * Whether the appointment `[start, start + minutes)` lies inside one of the entry's windows
 * (local wall-clock times in the business's time zone).
 */
export function windowsHold(
  windows: readonly WaitlistWindow[],
  timeZone: string,
  start: number,
  minutes: number,
): boolean {
  const end = start + minutes * MINUTE_MS;
  return windows.some((w) => {
    const day = parseDate(w.date);
    const from = fromZoned(timeZone, day, minutesOfDay(w.start));
    const to = fromZoned(timeZone, day, minutesOfDay(w.end));
    return start >= from && end <= to;
  });
}

/** The ranking's order: fit, then waiting longest, then most visits, then the id. */
export function compareCandidates(
  a: WaitlistCandidate,
  b: WaitlistCandidate,
  staffMemberId: string,
): number {
  const fitOf = (c: WaitlistCandidate) => (c.staffMemberId === staffMemberId ? 0 : 1);
  return (
    fitOf(a) - fitOf(b) ||
    a.createdAt.getTime() - b.createdAt.getTime() ||
    b.visits - a.visits ||
    (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0)
  );
}

/**
 * The best `fanOut` candidates for a slot of `staffMemberId`, best first. Entries for another
 * staff member are never offered it; the caller has already dropped those that don't fit.
 */
export function rankCandidates<C extends WaitlistCandidate>(
  candidates: readonly C[],
  staffMemberId: string,
  fanOut: number,
): RankedCandidate<C>[] {
  return candidates
    .filter((c) => c.staffMemberId === null || c.staffMemberId === staffMemberId)
    .sort((a, b) => compareCandidates(a, b, staffMemberId))
    .slice(0, Math.max(0, fanOut))
    .map((candidate, index) => ({
      candidate,
      fit: candidate.staffMemberId === null ? 'anyone' : 'asked_for_staff',
      rank: index + 1,
    }));
}
