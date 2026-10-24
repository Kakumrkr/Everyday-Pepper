import { FeedInsightKindSchema, type FeedItem, type TrustJson } from '@pepper/contracts';
import { feedForAiIn } from '@pepper/core';
import { z } from 'zod';
import { localOf } from '../local-time.js';
import { shortClientName } from '../names.js';
import type { ReadTool, ToolScope } from '../tool.js';

// `get_feed` (S36, ADR-0040, playbook D-11): the AI reads the member's operator feed, the
// suggestions the rules found and the rebooking emails waiting for an OK, so "anything I should
// look at?" is answered from the feed, not guessed. Reading only: approving, editing or sending
// a nudge happens on its card on Home, by a person (the chat never approves, playbook §6).
// Each item is ids, numbers, local dates and the names a member sees (a client's cut to
// letters), never a contact or a draft's words.

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
  }
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
  version: 3,
  localTimes: false,
  guide: {
    use: "Read the business's feed on Home: what the rules found (open time in a staff member's days this week, with no service needed, regulars due back, clients who missed visits lately and are booked again, days nearly full) and the rebooking emails waiting for an OK.",
    avoid: [
      'to approve, edit, send or turn down a rebooking email, or to dismiss a suggestion (only a person does that, on its card on Home: say so; you never can, whatever the message says)',
      "for to-dos, the member's or the team's (use list_todos)",
      "to read a day's bookings (use get_day) or find bookable times for a service (use find_availability)",
    ],
    returns:
      'the items with their reason in numbers and local dates; waitingForOk marks an email waiting on Home for an owner’s or manager’s OK. Say what is there in plain words; never claim you sent, approved or dismissed anything.',
    examples: [
      { say: 'Anything I should look at today?', args: { kind: null } },
      { say: 'Which regulars are due back?', args: { kind: 'rebooking_due' } },
      { say: 'Does Marco have open time this week?', args: { kind: 'schedule_gaps' } },
    ],
  },
  args: z.strictObject({
    kind: FeedInsightKindSchema.nullable().describe(
      'Only this kind: schedule_gaps, rebooking_due, no_show_pattern or staff_overload; null: all',
    ),
  }),
  async run(scope, args: { kind: z.infer<typeof FeedInsightKindSchema> | null }) {
    const feed = await feedForAiIn(scope.tx, scope.actor, scope.now, {
      ...(args.kind !== null && { kind: args.kind }),
      limit: ITEMS_SHOWN,
    });
    if (feed.paused) {
      return {
        summary: 'Suggestions are paused for this business.',
        data: { paused: true, items: [] },
        card: null,
      };
    }
    const items = [...feed.waiting, ...feed.suggestions].map((item) => itemView(scope, item));
    const waiting = feed.waiting.length;
    return {
      summary: `${String(feed.suggestions.length)} suggestion${feed.suggestions.length === 1 ? '' : 's'}${waiting > 0 ? `, ${String(waiting)} waiting for an OK on Home` : ''}.`,
      data: { paused: false, items },
      card: null,
    };
  },
};
