# ADR-0056: Overdue regulars fill what the waitlist leaves; offer and fill receipts

- **Status:** Accepted. Pre-approved by the user at the S54 brief on 2026-11-04 ("pre-approved with your recommendation").
- **Date:** 2026-11-04
- **Builds on:** ADR-0041 (the smart waitlist), ADR-0039 (insights, `rebooking_due`), ADR-0040 (rebooking nudges, the unsubscribe footer), ADR-0028 (the dial), ADR-0043 (Activity)

## Context
S54 is the money loop: a cancelled slot gets filled, and the owner sees what it was worth. Until S54 a freed time went only to people on the waitlist. Most small shops have a short waitlist or none, but they do have regulars who are overdue: the insights pass already finds them (`rebooking_due`). The playbook asks for waitlist and overdue regulars to be ranked together, the offer to follow the dial, a receipt ("Filled Tue 2 pm, +$60"), a cancelled slot offered in under 2 minutes at the 95th percentile, and 0 wrong-client sends. The win-back list and the post-import aha moved to S54.2 (D-1).

## Decision
1. **Regulars come after the waitlist (D-2).** The ranking (ADR-0041) fills the fan-out with the waitlist first, one offer per client. Only the seats left go to overdue regulars of the freed time's staff member (`regularCandidatesIn`). A regular qualifies only when all of these hold:
   - They have an open `rebooking_due` suggestion on the feed (not dismissed, not waiting on a nudge's OK).
   - They have an email address, have not opted out, and have not been deleted.
   - Nothing is booked for them ahead.
   - They had no regular's offer in the last 7 days (`REGULAR_OFFER_QUIET_DAYS`).
   - They are not the client who freed the time.
   - Their last service is bookable at exactly that time.

   Regulars rank most overdue first, then by most visits, then by id. Every rule is checked again when the offer is made, so an approval given hours later still can't reach a client who booked meanwhile.
2. **An offer without an entry (migration 0064).**
   - `waitlist_offers.entry_id` is nullable, and `source` says `waitlist` or `regular`. A check constraint ties the two together.
   - A partial unique index (match, client) applies to regulars.
   - Claims, Undo and expiry work the same way. A regular's offer has no entry to put back.
   - A regular is never sent "that time has been taken": they weren't waiting for it.
3. **The regular's email is marketing.** It holds the same single-use claim link, plus the nudge's footer: the business's mailing address and a one-click unsubscribe link. Without a mailing address, no regular is offered anything.
4. **Same dial, same tool.** Offers to regulars go through `send_waitlist_offers` and `message.waitlist_offer`, so "ask" stays the default. The tool is never offered to the model, so no recorded cassette changes (D-4).
   - *Why?* names a regular's due date (the `rebooking_due` fact).
5. **Receipts with dollars (AC-W5-5).**
   - The action records `valueCents`: the best-ranked offer's service at its listed price. The summary says "~$60".
   - `GET /v1/ai/actions` adds `fill` to a waitlist offer: `filled` (the claimant's short name and the booking's price), `open` or `unclaimed`.
   - Activity's line reads "Offered Tue, Nov 10, 2:00 pm to Maria L. and Ana R., ~$60". Once the time is claimed it reads "Filled … with Ana R., +$60", or "…; nobody claimed it" when no one did.
6. **Measured.** The real worker (Postgres, Redis, BullMQ) offers ten simultaneous cancellations with p95 under 2 minutes (`apps/worker/src/waitlist.int.test.ts`). The fixtures prove that none of these clients is offered a time:
   - the client who cancelled;
   - another staff member's regular;
   - a client who opted out, has no address, was deleted or is booked ahead;
   - a client offered within the last 7 days;
   - any regular, when the business has no mailing address;
   - a client who booked between the ranking and the offer.

   Concurrent claims that include a regular still make exactly one booking.

## Consequences
- A shop with an empty waitlist can now fill a cancellation from its own regulars, and Activity shows the money.
- Two simultaneous freed times can both reach the same regular (the 7-day check is not locked); that is at most two emails to a client who is due back, never the wrong client.
- `fill` is read per waitlist receipt (one query each). These receipts are rare; batch the reads if Activity grows.
