import type { DailyBriefingPayload, FeedItem, FeedKind } from '@pepper/contracts';
import { formatDate, formatInstant } from '../cards/labels.js';

// The words of a feed suggestion (S35, ADR-0039), written by code from the item's ids, numbers
// and the names the member may see: never by the model, never from stored free text.

export interface FeedLine {
  title: string;
  why: string;
}

/** What a kind is called in a sentence ("open gaps", plural). */
export const FEED_KIND_NOUN: Record<FeedKind, string> = {
  schedule_gaps: 'open gaps',
  rebooking_due: 'regulars who are due',
  no_show_pattern: 'no-show patterns',
  staff_overload: 'busy weeks',
  waitlist_match: 'freed times for the waitlist',
  daily_briefing: 'daily briefings',
};

const count = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * The daily briefing in words (S38a, ADR-0042): a headline and one line per thing worth
 * knowing, from the numbers alone (zeros left out).
 */
export function briefingLines(
  payload: DailyBriefingPayload,
  timeZone: string,
): { title: string; lines: string[] } {
  const lead = payload.scope === 'business' ? 'Today' : 'Your day';
  const title =
    payload.bookingCount === 0 || payload.firstStartsAt === null
      ? `${lead}: nothing booked yet`
      : `${lead}: ${count(payload.bookingCount, 'booking')}, the first at ${clockTime(payload.firstStartsAt, timeZone)}`;
  const lines: string[] = [];
  if (payload.gapCount > 0) {
    lines.push(
      `${count(payload.gapCount, 'open gap')} to fill, ${formatDuration(payload.openMinutes)} in all.`,
    );
  }
  const needsOk = payload.needsOkCount ?? 0;
  if (needsOk > 0) {
    lines.push(`${count(needsOk, 'thing')} ${needsOk === 1 ? 'waits' : 'wait'} for your OK.`);
  }
  const due = payload.rebookingDueCount ?? 0;
  if (due > 0) lines.push(`${count(due, 'regular')} ${due === 1 ? 'is' : 'are'} due back.`);
  const waiting = payload.waitlistWaiting ?? 0;
  const offered = payload.waitlistOffered ?? 0;
  if (waiting > 0 || offered > 0) {
    const since =
      offered === 0
        ? ''
        : `; ${count(offered, 'offer')} sent since yesterday, ${String(payload.waitlistClaimed ?? 0)} claimed`;
    lines.push(`${String(waiting)} on the waitlist${since}.`);
  }
  if (lines.length === 0) lines.push('Nothing needs you this morning.');
  return { title, lines };
}

/** "2 h 15 min", "45 min", "3 h". */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${String(rest)} min`;
  return rest === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(rest)} min`;
}

/** "1:30 pm" in the business's time zone. */
export function clockTime(iso: string, timeZone: string): string {
  return formatInstant(iso, timeZone).split(', ').at(-1) ?? iso;
}

function weeksAgo(iso: string, now: number): string {
  const days = Math.max(0, Math.round((now - Date.parse(iso)) / 86_400_000));
  return days < 14 ? `${String(days)} days ago` : `${String(Math.round(days / 7))} weeks ago`;
}

export function feedLine(item: FeedItem, timeZone: string, now: number): FeedLine {
  const staff = item.names.staff ?? 'A team member';
  const client = item.names.client ?? 'A client';
  switch (item.kind) {
    case 'schedule_gaps': {
      const { gapCount, openMinutes, longestStartsAt, longestEndsAt } = item.payload;
      const longest = `${clockTime(longestStartsAt, timeZone)}–${clockTime(longestEndsAt, timeZone)}`;
      return {
        title: `${staff} has ${formatDuration(openMinutes)} open on ${formatDate(item.day)}`,
        why:
          gapCount === 1
            ? `Free ${longest}, inside working hours. It goes away when it's booked or the day ends.`
            : `${String(gapCount)} open stretches, the longest ${longest}. It goes away when they're booked or the day ends.`,
      };
    }
    case 'rebooking_due': {
      const { lastVisitAt, intervalDays, basis } = item.payload;
      const what = item.names.service === null ? 'back' : `for ${item.names.service}`;
      const habit =
        basis === 'service'
          ? `${item.names.service ?? 'This service'} usually rebooks every ${String(intervalDays)} days`
          : `They usually come every ${String(intervalDays)} days`;
      return {
        title: `${client} is due ${what}`,
        why: `Last visit ${weeksAgo(lastVisitAt, now)}. ${habit}. Nothing is booked yet.`,
      };
    }
    case 'no_show_pattern': {
      const { noShowCount, windowDays, bookingStartsAt } = item.payload;
      return {
        title: `${client} missed ${String(noShowCount)} visits lately and is booked ${formatInstant(bookingStartsAt, timeZone)}`,
        why: `${String(noShowCount)} no-shows in the last ${String(windowDays)} days. A confirmation the day before often helps.`,
      };
    }
    case 'staff_overload': {
      const { busyDays, horizonDays, peakPercent } = item.payload;
      return {
        title: `${staff} is 90% booked or more on ${String(busyDays.length)} of the next ${String(horizonDays)} days`,
        why: `${busyDays.map(formatDate).join(', ')}. The fullest is ${String(peakPercent)}% booked.`,
      };
    }
    case 'waitlist_match': {
      const { startsAt, state, offered } = item.payload;
      const when = formatInstant(startsAt, timeZone);
      return {
        title:
          state === 'claimed'
            ? `${staff}'s ${when} was rebooked from the waitlist`
            : `${staff}'s ${when} opened up`,
        why:
          state === 'needs_ok'
            ? 'People on the waitlist fit it. The offers wait for your OK above.'
            : state === 'offered'
              ? `Offered to ${count(offered, 'person', 'people')} on the waitlist. The first to claim it gets it.`
              : offered === 1
                ? 'Claimed by the person it was offered to.'
                : `Claimed by one of the ${String(offered)} people it was offered to.`,
      };
    }
    case 'daily_briefing': {
      const { title, lines } = briefingLines(item.payload, timeZone);
      return { title, why: lines.join(' ') };
    }
  }
}
