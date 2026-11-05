# ADR-0058: Proof of value: the week card and the evening wrap, read on demand

- **Status:** Accepted. Pre-approved by the user at the S55 brief on 2026-11-05 ("pre-approved with your recommendation").
- **Date:** 2026-11-05
- **Builds on:** ADR-0039 (insights, the no-show pattern), ADR-0040 (rebooking nudges), ADR-0042 (the daily briefing), ADR-0043 (the card board), ADR-0056 (fills and their receipts), ADR-0057 (win-back, computed on read)

## Context
S55 is "proof of value" (playbook Phase 12). An owner should see in dollars what Pepper did for them. They should also see tomorrow at the end of the day: how many visits, from when, and who might not show. Post-visit review requests were in the same playbook row. They need a new dial action, an email, a 90-day cap, opt-out and an Activity line, so they are a feature of their own and move to S55.2 (D-1).

## Decision
1. **Computed when Home asks (D-2).** `GET /v1/proof` answers `{ week, evening }` from the bookings, the waitlist's offers and the AI's executions. This follows "Haven't been back" (ADR-0057): no migration, no worker pass, no new feed kind. A fill or a booking shows the moment it happens. Pure builders (`buildWeekValue`, `buildEveningWrap`, appointments) take the rows; the db reads only select them (`listWeekBookings`, `countWeekActions`).
2. **The week (last 7 days, by when a visit was booked).** A visit counts when Pepper had a hand in it:
   - it was booked online (`booking_page`) or by the AI (`ai`);
   - a claimed waitlist or regular's offer made it (a freed time filled);
   - its client got a rebooking or win-back nudge (`message.rebooking_nudge`, done, not undone) in the 14 days before. This is a **regular back**, counted once, by their first such booking (AC-W4-11, the S54.2 retro's top-up).

   Each visit counts once in the dollars: its booked price, else its service's. Cancelled visits, imported history and deleted clients count for nothing.
3. **Minutes saved (D-3).** One table in contracts, `MINUTES_SAVED`: a booking made without the owner 4, a fill 10 on top, an email Pepper sent 3, any other action 2 (an AI booking's own `booking.create` is not counted twice). The card says "about", rounded to 5 minutes. These are estimates, kept in one place so the card and its tests agree. The owner time model (`packages/testing/src/owner-time.ts`) stays test-only.
4. **The evening wrap.** From 17:00 until midnight in the business's time zone (`PROOF_LIMITS.eveningHour`): tomorrow's standing visits, the first start, and the visits at risk. A visit is at risk when its client has the feed's no-show pattern (2 in 180 days). Up to 3 are named; the count covers all. Before 17:00 there is no wrap; an empty tomorrow says so. It informs only, with no push or email, like the briefing.
5. **Access.** Owners and managers only: the dollars and the names are the business's (`requireWinBackAccess`; 403 for staff). Home asks only when the member holds `settings.manage`. A week where Pepper did nothing shows no card (AC-W4-13); Home's quiet start stays quiet.
6. **Placement.** The wrap goes first on Home, above the morning briefing: in the evening it is the timely thing. The week card follows "Done for you", the receipts it adds up. Both are flat blocks, not raised cards, because nothing in them needs a decision (DESIGN.md §2).

## Consequences
- A regular back is attribution, not proof: a client nudged and then booked by the owner within 14 days counts. The window keeps it honest enough for the card; the S73 reports can refine it.
- The week window is rolling (the last 7 days), not a calendar week; the card says "this week". A calendar-week summary, pushed on a fixed day, can come later without changing the numbers.
- The wrap depends on the wall clock, so Home's screenshot leaves it out; the gallery shoots both blocks in fixed states.
- Each Home load reads a week of bookings and executions. That is fine at pilot sizes; a count-only read or a cache comes if Home grows slow.
- No migration, no new dial action, no model call, no cassette change.
