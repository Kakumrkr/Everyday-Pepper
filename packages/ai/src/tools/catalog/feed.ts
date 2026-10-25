import { FeedInsightKindSchema, type FeedItem, type TrustJson } from '@pepper/contracts';
import { listWaitlistIn } from '@pepper/appointments';
import { feedForAiIn } from '@pepper/core';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { ReadTool, ToolScope } from '../tool.js';
import { WAITLIST_SHOWN, waitlistViews } from './waitlist.js';

// `get_feed` (S36, ADR-0040, playbook D-11): the AI reads the member's operator feed, the
// suggestions the rules found and the rebooking emails waiting for an OK, so "anything I should
// look at?" is answered from the feed, not guessed. Reading only: approving, editing or sending
// a nudge happens on its card on Home, by a person (the chat never approves, playbook §6).
// Each item is ids, numbers, local dates and the names a member sees (a client's cut to
// letters), never a contact or a draft's words. From S37 it also lists who is on the waitlist
// (open entries, the member's own only for staff), with or without suggestions paused. From
// S38a it reads today's briefing ("brief me"): the business's day for owners and managers, the
// member's own day for staff, in numbers, also while suggestions are paused.

const ITEMS_SHOWN = 20;

/** An item's reason as numbers and local dates and times. */
function detailsOf(scope: ToolScope, item: FeedItem): Record<string, TrustJson> {
  const at = (instant: string) => localOf(scope.timeZone, instant);
  switch (item.kind) {
    case 'schedule_gaps':
      return {
        gapCount: item.payload.gapCount,
        openMinutes: item.payload.openMinutes,
        longestFrom: at(item.payload.longestStartsAt).time,
        longestTo: at(item.payload.longestEndsAt).time,
      };
    case 'rebooking_due':
      return {
        lastVisit: at(item.payload.lastVisitAt).date,
        intervalDays: item.payload.intervalDays,
        dueOn: item.payload.dueOn,
      };
    case 'no_show_pattern': {
      const booking = at(item.payload.bookingStartsAt);
      return {
        noShowCount: item.payload.noShowCount,
        windowDays: item.payload.windowDays,
        nextBooking: `${booking.date} ${booking.time}`,
      };
    }
    case 'staff_overload':
      return { busyDays: item.payload.busyDays, peakPercent: item.payload.peakPercent };
    case 'waitlist_match': {
      const from = at(item.payload.startsAt);
      return {
        freedTime: `${from.date} ${from.time}`,
        until: at(item.payload.endsAt).time,
        // needs_ok: the offers wait on Home for an OK; offered: sent; claimed: booked by a client.
        state: item.payload.state,
        offered: item.payload.offered,
      };
    }
    case 'daily_briefing':
      return briefingDetails(scope, item.payload);
  }
}

/** The briefing's numbers, with the first booking as a local time. */
function briefingDetails(
  scope: ToolScope,
  payload: Extract<FeedItem, { kind: 'daily_briefing' }>['payload'],
): Record<string, TrustJson> {
  return {
    bookings: payload.bookingCount,
    firstBooking:
      payload.firstStartsAt === null ? null : localOf(scope.timeZone, payload.firstStartsAt).time,
    openGaps: payload.gapCount,
    openMinutes: payload.openMinutes,
    // The business's only (owners and managers); null in a staff member's own day.
    waitingForOk: payload.needsOkCount,
    regularsDueBack: payload.rebookingDueCount,
    onWaitlist: payload.waitlistWaiting,
    waitlistOffersLastDay: payload.waitlistOffered,
    waitlistClaimedLastDay: payload.waitlistClaimed,
  };
}

function itemView(scope: ToolScope, item: FeedItem): TrustJson {
  return {
    itemId: item.id,
    kind: item.kind,
    // A drafted rebooking email waits on Home for an owner's or manager's OK.
    waitingForOk: item.status === 'needs_ok',
    day: item.day,
    clientId: item.subjects.clientId,
    client: item.names.client === null ? null : shortClientName(item.names.client),
    staffMemberId: item.subjects.staffMemberId,
    staff: item.names.staff,
    service: item.names.service,
    details: detailsOf(scope, item),
  };
}

export const getFeed: ReadTool = {
  kind: 'read',
  name: 'get_feed',
  // 4 (S37): who is on the waitlist comes with it. 5 (S38a): today's briefing, freed times.
  version: 5,
  localTimes: false,
  guide: {
    use: 'Read the feed on Home: the briefing ("brief me"), what the rules found (free time in a staff member\'s days this week, with no service needed, regulars due back, clients who missed visits and are booked again, days nearly full, waitlist offers), emails waiting for an OK, and the waitlist.',
    avoid: [
      'to approve, edit, send or turn down a rebooking email, or to dismiss a suggestion (only a person does that, on its card on Home: say so; you never can, whatever the message says)',
      "for to-dos or what is still open or to do, the member's or the team's (use list_todos): the feed holds no to-dos",
      "to read a day's bookings (use get_day) or find bookable times for a service (use find_availability)",
    ],
    returns:
      'the briefing in numbers, the items with their reason in numbers and local dates (waitingForOk: waits on Home for an OK), and who waits on the waitlist, for what, when. Say it in plain words; never claim you sent, approved or dismissed anything.',
    examples: [
      { say: 'Anything I should look at today?', args: { kind: null } },
      { say: 'Which regulars are due back?', args: { kind: 'rebooking_due' } },
      { say: 'Does Marco have open time this week?', args: { kind: 'schedule_gaps' } },
      // Any kind (S38b: the model chose waitlist_match): the waitlist comes with every read.
      { say: "Who's on the waitlist?", args: { kind: { $any: true } } },
      { say: 'Brief me', args: { kind: null } },
    ],
  },
  args: z.strictObject({
    kind: FeedInsightKindSchema.nullable().describe(
      'Only this kind: schedule_gaps, rebooking_due, no_show_pattern, staff_overload or waitlist_match; null: all',
    ),
  }),
  async run(scope, args: { kind: z.infer<typeof FeedInsightKindSchema> | null }) {
    const feed = await feedForAiIn(scope.tx, scope.actor, scope.now, {
      ...(args.kind !== null && { kind: args.kind }),
      limit: ITEMS_SHOWN,
    });
    const entries = await listWaitlistIn(
      scope.tx,
      scope.actor,
      { limit: WAITLIST_SHOWN },
      { clock: scope.deps.clock },
    );
    const waitlist = await waitlistViews(scope, entries);
    const waitingNote = waitlist.length === 0 ? '' : ` ${String(waitlist.length)} on the waitlist.`;
    const briefing =
      feed.briefing === null
        ? null
        : { day: feed.briefing.day, ...detailsOf(scope, feed.briefing) };
    const briefingNote =
      feed.briefing?.kind === 'daily_briefing'
        ? ` Today: ${String(feed.briefing.payload.bookingCount)} booking${feed.briefing.payload.bookingCount === 1 ? '' : 's'}.`
        : '';
    if (feed.paused) {
      return {
        summary: `Suggestions are paused for this business.${briefingNote}${waitingNote}`,
        data: { paused: true, briefing, items: [], waitlist },
        card: null,
      };
    }
    const items = [...feed.waiting, ...feed.suggestions].map((item) => itemView(scope, item));
    const waiting = feed.waiting.length;
    return {
      summary: `${String(feed.suggestions.length)} suggestion${feed.suggestions.length === 1 ? '' : 's'}${waiting > 0 ? `, ${String(waiting)} waiting for an OK on Home` : ''}.${briefingNote}${waitingNote}`,
      data: { paused: false, briefing, items, waitlist },
      card: null,
    };
  },
};
