# ADR-0041: The smart waitlist: match rows, ranked offers through the dial, single-use claims

- **Status:** Accepted. Pre-approved by the user at the S37a brief on 2026-10-24 ("Just go with your recommendations and complete the job").
- **Date:** 2026-10-24
- **Builds on:**
  - ADR-0017 (bookings and the waitlist entry model)
  - ADR-0022 (the public booking page and its link secrets)
  - ADR-0024 (outbox)
  - ADR-0028 (trust layer, the dial, the Undo grace)
  - ADR-0029 (tools)
  - ADR-0040 (`proposeForBusiness`, system tools)
  - [Phase 8 playbook](../plan/phase-8-playbook.md) §2, §3 (S37) and [PCR-006](../plan/changes/PCR-006.md)

## Context
AC-W5-1: when a booking is cancelled, the time is offered to the best-matching people on the waitlist within 2 minutes, and the first to claim it gets it. Since S12 a waitlist entry holds a client, a service, a staff member or "anyone", and up to 10 local-time windows; nothing used them. PCR-006 adds the matching, the offers to the top 3, a claim page, the chat tool `add_to_waitlist` and the dial action `waitlist.change`. The playbook (D-6) starts offers at "ask".

The brief settled five questions (Claude's recommendations, taken):
- **D-1:** offers follow the dial (`message.waitlist_offer`). At "ask" (the default) the offer is one proposal under "Needs your OK"; at "notify" or "auto" the emails are queued at once.
- **D-2:** AC-W5-1's 2-minute clock ends when the offer is made: the proposal stored, or the emails queued. The emails then leave after the 120 s Undo grace (ADR-0028), so Undo can still take them back.
- **D-3:** a `waitlist_matches` table written in the freeing transaction, not a new outbox type (the outbox seals its payload with `OUTBOX_SECRET`, which not every booking path holds).
- **D-4:** no existing tool's guide changes in S37a, so S37b records once. (Moot: adding a tool stales every recorded cassette anyway, and `get_feed` / `find_client_bookings` gained the waitlist in their data and returns text.)
- **D-5:** this ADR.

## Decision
1. **A match row per freed time (D-3).** Cancelling a booking, or moving it (its old time), by the team or by the client's link, inserts a `waitlist_matches` row (migration 0046: tenant, the freed booking, staff member, start, end, status `pending`/`running`/`done`, outcome, attempts, `available_at`) in the same transaction. Nothing is matched if the change rolls back.
   - The worker's `WaitlistModule` relays due rows (scan under `job_scan('waitlist')`, ids only, every `WAITLIST_POLL_MS`, 5 s by default) to the BullMQ queue `waitlist`, one job per row with the row id as job id, so a row is queued once.
   - The job (`runWaitlistMatch`, OTel span `waitlist.match`) leases the row with a conditional update (`MATCH_LEASE_MS`), so two workers never match the same time; a second job for a finished row is skipped. A failure retries with back-off, at most `WAITLIST_MATCH_MAX_ATTEMPTS` (5).
   - The waitlist runs only when `AUTH_BASE_URL` is set (claim links need the web origin).
2. **Candidates and ranking.** Waiting entries for the service whose windows hold the whole freed time (in the business's time zone), for that staff member or anyone, whose client has an email, and for whom the time is still bookable (`isBookable`: hours, time off, rules, other bookings). At most `WAITLIST_OFFER_LIMITS.maxCandidates` (200) are read.
   - Ranking is lexicographic and pure (`waitlist-ranking.ts`, property-tested): asked for this staff member before "anyone", then waiting longest, then most completed visits, then id. No template weights: one rule everyone can explain in *Why?* (facts `waitlist_rank`).
   - Clients without an email are not offered (there is no other channel before SMS).
3. **Offers to the top N, through the dial (D-1, D-2).** The system tool `send_waitlist_offers` (no chat model calls it) runs through the trust layer's new `actForBusiness`: the dial decides, unlike `proposeForBusiness`, which always proposes.
   - N is the template's `waitlist.offerFanOut` (default 3, at most 5).
   - An offer (`waitlist_offers`, migration 0046, hardened in 0047) closes at `min(now + 2 h, start − 1 h)`; no offer is made with less than 15 minutes left to claim.
   - The entries offered become `offered`. Each client gets their own email (dedupe `waitlist.offer:<offerId>`) with a claim link `/book/<slug>/offer#<token>`: a 256-bit base64url secret in the fragment; only its SHA-256 is stored.
   - Undo (until the emails leave) takes the offers back and the entries return to `waiting`.
   - A proposal belongs to the business (`requestedBy` null, audited as system), and owners and managers approve it (as nudges, ADR-0040).
4. **Claims take turns; the first books.** `POST /v1/public/businesses/<slug>/waitlist-offer/claim` (rate limit `claim-ip`, 10 per 10 minutes) locks the match row `FOR UPDATE`, so N claims of one time run one after another and exactly one books (integration test with 5 concurrent claims). The booking is made through the normal booking service (rules, occupancy constraint).
   - The other open offers of that time become `taken`, their entries go back to `waiting`, and their clients are emailed "That time … has been taken" (dedupe `waitlist.taken:<offerId>`).
   - Errors say what happened to the offer and never who holds the time: 404 `waitlist_offer_not_found`, 409 `waitlist_offer_used` (this link already booked), 409 `waitlist_offer_taken`, 410 `waitlist_offer_expired`. The booked client gets the usual confirmation with a manage link.
   - `POST …/waitlist-offer/lookup` (the `LINK_USES` limit) reads the offer for the page and changes nothing.
5. **Expiry.** The matcher and the daily clean-up (`expireWaitlistOffers`) mark open offers past their time `expired` and release their entries. These status flips are not audited (no one acted; the offer row keeps the times).
6. **`add_to_waitlist` and `waitlist.change`.** The 21st chat tool puts a client on the waitlist (dial action `waitlist.change`, `internal_write`, default "do it and tell me", Undo removes the entry for 7 days; migration 0048 widens the action checks). Staff add only their own clients, for their own staff member (the record owner is the staff member's login). `get_feed` (v4) and `find_client_bookings` (v3) show who is waiting; the agent instructions are v7.
7. **Screens.** The claim page `/book/<slug>/offer#<token>` (`ClaimOffer`) and a read-only `/waitlist` screen (who is waiting, the latest offers by time and their state, `GET /v1/waitlist/offers`), linked from Calendar. Offers waiting for an OK are on Home.

## Deferred
- A `waitlist_match` feed item and "Join the waitlist" on the booking page: to S38a.
- Editing or removing entries from `/waitlist` (the booking sheet already adds them; the chat adds and undoes).

## Consequences
- AC-W5-1 is tested end to end: on the real worker with Postgres, Redis and Mailpit (`apps/worker/src/waitlist.int.test.ts`, ask and auto paths, within 2 minutes) and in the browser (`e2e/tests/waitlist.spec.ts`: cancel, approve on Home, claim, "taken").
- A journey that waits for an offer email waits out the 120 s Undo grace (about 2.2 minutes per project).
- A new tool changes every recorded request's fingerprint: S37b re-records the whole suite once (about $0.20–0.25). The worst case of a 20-case chunk with 21 tools went over the $1.50 run cap, so `MAX_CASES_PER_RUN` is 18.
- Eval sets: `waitlist` (12 cases, gate 0.9) and 2 more `feed_safety` cases, green on the scripted model.
