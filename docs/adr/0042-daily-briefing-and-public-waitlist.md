# ADR-0042: The daily briefing, the `waitlist_match` feed item and "Join the waitlist"

- **Status:** Accepted. Pre-approved by the user at the S38a brief on 2026-10-25 ("Go with your recommendations").
- **Date:** 2026-10-25
- **Builds on:**
  - ADR-0022 (the public booking page, its codes)
  - ADR-0026 (pushes)
  - ADR-0039 (the feed, `syncFeedItems`, the insights pass)
  - ADR-0040 (the morning drafts pass, `get_feed`)
  - ADR-0041 (the smart waitlist)
  - [Phase 8 playbook](../plan/phase-8-playbook.md) §7 (S38), F-4, D-8

## Context
S38 closes Phase 8. The playbook asks S38a for:
- the morning run per business at its local hour (default 7:00, a business setting);
- one briefing feed item with today's bookings and first start, the gaps, what needs the owner, overdue regulars and waitlist activity;
- template text (no model), a push to owners and managers, and each staff member's own day to them;
- "brief me" through `get_feed`; no morning email (D-8).

S37a deferred two items to S38a (ADR-0041):
- the `waitlist_match` feed item;
- "Join the waitlist" on the booking page when nothing fits.

S37b carried one real-model miss, `move-done-no-approval-talk`. Before a move, the model asked `find_availability`. That tool counts the booking's own time as taken, so the model offered 3:15 instead of moving the booking to 3:00.

## Decision
1. **A briefing kind and a business subject.** Migration 0049 changes three things:
   - `feed_items.kind` also allows `daily_briefing`;
   - `subject_key` also allows `business:<uuid>`;
   - `insight_runs.briefing_due_at` is added.

   Contracts:
   - `FeedKindSchema` is the insight kinds plus `daily_briefing`.
   - `FeedInsightKindSchema` stays the insights pass's kinds, now with `waitlist_match`: a business may turn those off, never the briefing.
   - `DailyBriefingPayloadSchema` holds numbers only:
     - bookings, first start, gaps and open minutes;
     - for the business only: proposals waiting for an OK, open "due back" items, and the waitlist (waiting now, offers and claims in the last 24 h).
2. **Two writers, each for its own kinds.**
   - `syncFeedItems` stays the insights pass's writer, and it expires only that pass's kinds.
   - `writeBriefings` writes the briefing. It inserts, or updates an unread item of the same local day, and leaves a read one alone.
   - `listOpenFeedItems` never returns a briefing. `readBriefing` reads it on its own: the `business:` item for owners and managers, the member's own `staff:` item for staff (`audience_staff_id`, under the existing member scope).
3. **The morning job.** It is one worker `Periodic` (`DRAFTS_POLL_MS`; 10 s in CI and e2e). Each run:
   - runs the drafts pass first, when it is configured (OpenAI and the web origin), so the briefing counts this morning's drafts;
   - then runs `runDueBriefings`.

   The briefing claims its own column, the same way as the drafts pass:
   - before the hour, it sets the due time to this morning's hour;
   - after it, a conditional update moves the due time to tomorrow's hour, so one worker wins.

   It never needs OpenAI. The hour is `feed_settings.morningHour` (5–11; `null` falls back to the template's `drafts.morningHour`), and the drafts pass uses the same hour. Changing the hour takes effect from the next due time.
4. **Content and words.**
   - `buildBriefings` is pure, like the providers. It works in the business's local day (DST-safe through `fromZoned`) and reuses `openGaps` from the gap provider.
   - The business briefing is always written.
   - A staff member's own day is written only for a staff member linked to a member with the staff role (owners and managers read the business view), and not on a day with no hours and nothing booked.
   - The words come from code: `briefingLines` / `feedLine` on Home, and `briefingPush` for the lock screen. The push never names a client.
   - The briefing runs while suggestions are paused, because it only informs. "Got it" closes it as done.
5. **Pushes.** Pushes go only when the worker sends pushes (VAPID keys set):
   - the business briefing to owners and managers (`leadUserIds`);
   - each own day to its staff member.

   The dedupe key is `push.briefing:<staff|business>:<day>`, so a second run of the same morning queues nothing again.
6. **`waitlist_match` from the insights pass.** The provider reads `listActiveWaitlistMatches`: freed times still ahead whose match was offered or proposed. It shows each one as one of three states:
   - `claimed`: a claimed offer exists;
   - `offered`: offers were made;
   - `needs_ok`: no offers yet, and the proposal is still pending (a turned-down proposal shows nothing).

   The item uses the subject `booking:<freed>` and is addressed to the staff member whose time it is, and to owners and managers. It expires at the slot's start. To show changes within a minute, two places ask for an insights run: the matcher after a `proposed` outcome, and `makeWaitlistOffersIn` after it makes offers. Its subqueries name `"waitlist_matches"."id"` in full, because a one-table drizzle query leaves the table off a column, and inside a subquery that would mean the subquery's own column.
7. **"Join the waitlist" (public).**
   - **Where:** a day with nothing free on the booking page offers it.
   - **Request:** it uses the booking code's flow, with `booking_verifications.purpose = 'waitlist'` (migration 0050). `starts_at` is the local day's start, and `waitlist_entry_id` is the result.
   - **Rate limits:** the hourly limit per email address is shared with booking requests, and so are the API's limits per address and per business.
   - **Codes never cross purposes:** a booking's code never adds an entry, and a waitlist code never books (`checkCode` checks the purpose under the row lock, and both confirms check it again).
   - **Confirming:**
     - it finds the client by the verified email, or adds them (`clientFor`);
     - it adds one whole-day window with the staff member or anyone, with no creator (`created_by_user_id` null);
     - it audits as the system;
     - a second request for the same day and service keeps the existing entry.
   - **Refusals:** a service nobody active offers (or not with that staff member) is refused, as on the page; a day that is over is `waitlist_expired`.
8. **Tools.**
   - `get_feed` v5 returns `briefing` (numbers and a local first time), also while suggestions are paused, and the `waitlist_match` details. Its guide gains "brief me" (example 5, so the earlier example ids keep their cassettes) and stays within the 1,024-character and 300-character `use` limits.
   - `find_availability` v4 adds an `avoid` line: before moving a booking to a time the member named, call `move_booking` with it, because `find_availability` still counts the booking's own time.
   - The eval action `morningBriefing` runs `runBriefingFor`. The scripted cases are `feed-brief-me`, `feed-brief-me-staff` (held out), `fs-brief-then-dismiss` and `tool-get-feed-5`.
9. **Phase 8 cap.** It rises from $1.25 to $1.75 (`PHASE_CAPS_USD`) for S38b's full re-record and pass^3. The plan is about $0.75:
   - probe, $0.05;
   - pass^1, $0.27;
   - pass^3 trials 2–3 on the gated sets, $0.35;
   - margin, $0.08.

   After S38b, total spend would be about $3.74 of the $5 credit. The runner stops at $4.50, so about $0.76 stays for Phases 9–11.

## Consequences
- Every recorded cassette is stale until S38b: the tool catalog changed (`get_feed` v5, `find_availability` v4). The scripted suite passes; the real-model replay fails as planned.
- Home shows the briefing card first. Before the first run, the card says when the briefing comes and holds the hour setting. Staff see nothing until their own day is written.
- Not built:
  - the staff own-day journey in Playwright (covered by the integration tests);
  - a way to turn the briefing off (pushes follow the device setting);
  - a morning email (D-8).
- When a client claims an offer, the `waitlist_match` item shows `claimed` until the slot starts. When an owner turns offers down, the item disappears at the next hourly run.

## Results (S38a)
- **Checks:** scripted evals pass; the real-model replay is stale as planned. Integration 1,233/1,234 before the review fixes; the one failure was that stale replay.
- **Code review findings fixed:**
  - A business whose briefing fails no longer stops the others, and its claim is released (due again now).
  - A failing drafts pass no longer skips the briefing.
  - A new morning hour moves each pass's next due time to that hour on the same local day.
  - A staff member on time off all day gets no own-day briefing.
  - A whole-day request no longer reuses a narrower entry the team made.
  - The public waitlist takes days up to 62 ahead (`waitlist_day_too_far`).
  - A freed time whose offers all closed unclaimed leaves the feed.
  - The drafts pass and the briefing share `claimMorning`.
- **Left as is:**
  - The snapshot is read twice each morning, once per business a day: cheap, and the insights pass keeps its own transaction.
  - The waitlist code email is sent at once rather than through the outbox, like the booking code (ADR-0022: the client waits for it; a failure answers 503).

## Results (S38b)
Recorded on Luna + Sol at effort `low`; every playbook §2 gate is met. Spend: $0.808 (Phase 8 $1.79 of $2.00, [ai-budget.md](../plan/ai-budget.md)). Set by set in the [security review](../engineering/security-review-s38.md#real-model-results-s38b).
- **pass^1 (252 cases):** every set at or above its gate; `waitlist` 10/12 with two named known misses (user: "Carry to Phase 9"). `move-done-no-approval-talk` passes (this ADR's `find_availability` v4 line).
- **pass^3 (167 cases):** `feed_safety`, safety, permissions, autonomy, memory_delete, memory_safety 100%; `drafts` 14/14, memory_recall 17/17, episodic 9/9, scheduling 49/50; `who-works-saturdays`, `lr-blackout`, `pasted-request-then-book` 3/3.
- **Fixed in S38b:**
  - `add_to_waitlist` v2: the client waits only once the tool answered "done"; add even when other times that day are free. Before it, Luna twice said a client was waiting without calling the tool.
  - Three cases fitted to the eval world: `tool-create-booking-1` (Maria already booked "tomorrow": the model rightly asked) and `tool-get-feed-4` (any `kind`: the waitlist comes with every read), neither sent to the model; `wl-staff-colleague-refused` (Marco's Saturday booked solid, the service named).
- **Carried to Phase 9 (user):** `wl-add-marco-saturday`, `wl-staff-own-client`: Luna still reads free times later that day as "not full". `add_to_waitlist` will check its windows in the domain (refusing with the free times when one is open), so the model calls it directly.
- **Cost guards (user):** the Phase 8 cap $1.75 → $2.00; `--phase-estimate-ok` also passes the $4.50 stop's estimate (its actual-spend stop stays); `--max-cost 2` for 12 single-case pass^3 runs.

## S44 note: the window check in the domain
`addToWaitlistIn` (the app's `POST /v1/waitlist` and the AI's `add_to_waitlist`) now refuses an entry whose windows still hold a time that can be booked (AC-W5-2): the same availability engine and rules as booking, with the staff member or anyone who offers the service, counting a time only when the whole appointment fits inside the window, exactly as the matcher would offer it (`windowsHold`). The refusal is `WaitlistTimesFreeError` with the earliest 3 free times: the api answers 409 `waitlist_times_free` with them as `alternatives`, and the AI gets `times_free` with the times as a slot picker. The tool's guide and version are unchanged, so the recorded cassettes stay valid; the two named misses (`wl-add-marco-saturday`, `wl-staff-own-client`) stayed in `KNOWN_REAL_MODEL_MISSES` until S56b recorded again; both passed there (waitlist 12/12) and the list is empty. The public "Join the waitlist" (a whole day the page showed as full) keeps no check: a time that frees up meanwhile is offered by the matcher. Test fixtures that seeded entries for open windows now join while the windows are full (time off around the join).
