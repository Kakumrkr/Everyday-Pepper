# ADR-0057: "Haven't been back" with one-tap drafts, and the post-import aha

- **Status:** Accepted. Pre-approved by the user at the S54.2 brief on 2026-11-05 ("Pre-approving with your recommendation").
- **Date:** 2026-11-05
- **Builds on:** ADR-0039 (insights, `rebooking_due`), ADR-0040 (rebooking nudges, the footer, the opt-out), ADR-0043 (dollars on the board), ADR-0050 (imported visits), ADR-0056 (regulars and the weekly quiet rule)

## Context
S54.2 is the second half of the money loop (playbook Phase 12). An owner needs to see who stopped coming and win them back with a tap. Right after importing past visits, they also need a first "aha": what the history is worth now ("12 regulars are overdue, about $540"). The feed's `rebooking_due` card is the wrong source for both:
- It lives from the due date to twice the interval, so a client gone for months is no longer on it.
- It needs 3 visits when the service names no interval.
- It is refreshed by the worker's insights pass, so straight after an import it may not exist yet.

## Decision
1. **A pure rule read on demand (D-2).** `findWinBack` (appointments, next to the insight providers) counts these clients over the 730-day history:
   - at least **2 past visits** (confirmed or completed; imported history included);
   - nothing confirmed ahead;
   - past their usual gap, with no upper bound. The gap is the last service's `rebook_after_days`, else the median gap between their visits (with 2 visits, the one gap).

   It is computed when the list is read (`listWinBackIn`), from bookings, so it is ready the moment an import commits. The order is the most recently due first, the most likely to come back. The empty state says the same rule: "After 2 visits, a client who stops coming shows here" (AC-W4-9).
2. **Value.** A client is worth their last service's own price, as the feed prices a regular (S52). When the service has none, the value is what that last visit cost: imported visits carry a price, but bring in hidden services without one. `count` and `totalCents` cover every client listed; at most 200 rows are returned. The post-import sentence and the Clients row use exactly these numbers (AC-W4-8).
3. **The draft is the rebooking nudge (D-3).** "Draft email" proposes `send_rebooking_nudge` (`message.rebooking_nudge`, ask by default) through `proposeForBusiness`. The proposal carries:
   - the client's next open time for the last service within 7 days, their own staff member first;
   - words the domain writes from the first name, the service and the date of the last visit. No model call: the tap is the owner's request, and the existing draft edit stays available.

   The tool is unchanged: the opt-out, the address, sensitive words and the time are all checked again at the send. The idempotency key is `winback.<client>.<local day>`. The proposal names the member who asked (`proposeForBusiness` takes `requestedBy`, and the audit names them); owners and managers decide it like every nudge. The client's open `rebooking_due` card links to it, so Home shows one decision, not two.
4. **Caps and quiet.**
   - At most **20 win-back drafts a business a day** (`WIN_BACK_LIMITS.perBusinessPerDay`, the morning pass's figure).
   - No draft for a client who had a nudge (pending, sent, turned down or expired) in the last 28 days, or a regular's offer in the last 7 (ADR-0056).
   - A second tap returns the draft that is already waiting.
   - A refusal is an answer (`{kind: 'refused', reason}`), and its words say what happens instead.
5. **Access.** `GET /v1/win-back` and `POST /v1/win-back/:clientId/draft` are for owners and managers only: a role whose `bookings.manage` scope is `all`. The list names every client of the business. Staff get 403.

## Consequences
- A client can be on "Haven't been back" without a feed card (2 visits, or more than twice the interval late). The board stays quiet about them; the list is where an owner goes looking.
- The words are plainer than the morning pass's model-written drafts. In return they cost nothing and never send a model a client's name; S56a may offer "write it for me".
- A hidden (inactive) service has no open times, so a client whose last visit was on one gets "I couldn't find an open time". Mapping imported services onto real ones comes with S56a's mapping suggestions.
- No migration, no new dial action, no recorded cassette changes.
