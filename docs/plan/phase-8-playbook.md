# Phase 8 Playbook — Operator feed

> **Status: Approved by the user (S34, 2026-10-24)** — "approved, go ahead with /session-close", after the brief's "Go ahead with your recommendations" (layout A, a $1.25 cap, BullMQ only for the waitlist, insights by rules and drafts by the model). Section 13's review additions are approved with it; the user can still adjust any decision at the S35 Session Brief. Every Phase 8 session (S35–S38) reads this file with `CLAUDE.md` and `STATUS.md`: the cross-cutting parts (1–6, 8–10) always, and its own section in 7. Changes after this follow the PCR process. Plan changes it implies: [PCR-006](changes/PCR-006.md).
>
> Builds on [jobs-messaging-integrations.md](../architecture/jobs-messaging-integrations.md), [modules-and-templates.md](../architecture/modules-and-templates.md) (insight providers, waitlist ranking), [ai-agent-and-trust-layer.md](../architecture/ai-agent-and-trust-layer.md), the [Phase 6](phase-6-playbook.md) and [Phase 7](phase-7-playbook.md) playbooks (their principles still hold), [ADR-0017](../adr/0017-bookings-clients-and-waitlist.md) (waitlist model), [ADR-0024](../adr/0024-transactional-outbox-and-email-delivery.md)–[ADR-0026](../adr/0026-tasks-and-web-push.md) (outbox, jobs, push), [ADR-0028](../adr/0028-trust-layer-proposals-executions-and-autonomy.md) (trust layer), [ADR-0033](../adr/0033-real-model-evals-and-model-choice.md) (models, runner), [ADR-0038](../adr/0038-what-i-know-and-the-remembered-chip.md) "S33" (the leftovers) and the acceptance criteria W4 and W5. Roadmap: Phase 8, "AC-W4-1, AC-W5-1; insight fixtures tested".

## 1. What we are building and why it wins

An employee doesn't wait to be asked. After Phase 7 Pepper acts, remembers and follows through, but only when someone opens the chat. Phase 8 makes it bring the work to the owner:

1. **The feed** becomes the home screen: **Done** (what Pepper did, with Undo), **Needs your OK** (proposals waiting for a tap) and **Suggestions** (things worth doing), each with a reason and approve or dismiss.
2. **Insights**, found by plain rules from the business's own data and template thresholds: open time tomorrow worth filling, regulars overdue for their next visit, a no-show pattern, a staff member overloaded, a waitlist match.
3. **Suggestions with drafts**: an insight that leads to a message comes with the email already written ("Hi Maria, it's been 8 weeks since your color — Jess has 10:00 or 11:30 free tomorrow"), shown under "Needs your OK" and sent once on approval (AC-W4-1, AC-W4-2).
4. **The smart waitlist**: when a booking is cancelled, Pepper ranks who is waiting for that time and offers the slot within 2 minutes — asked first or sent, per the autonomy dial; the first client to confirm gets it and the others are told it's taken (AC-W5-1).
5. **The daily briefing**: at the business's local morning, one card (and a push) says what today holds and what needs the owner — readable in ten seconds.

**The market (desk research, S34; vendor pages and blogs, so indicative):**
- Waitlists that fill cancellations exist at the high end (Zenoti: notify the next guest with a response window; a WordPress add-on ranks by loyalty and no-show risk and sends a timed claim link; Fresha added waitlists). They run on fixed rules with **no owner-level control** between "off" and "send to everyone", and the owner learns afterwards.
- "AI insights" in salon tools are mostly **dashboards and reports** (Salonist, Saloniq guides): the owner has to read them and then go do the work elsewhere. Rebooking messages are fixed templates sent by a schedule, not drafted for the slot that is actually open.
- Reviews of the big suites (S28 scan) still rate their AI "limited" for anything beyond booking.

**The gap Pepper takes:** a feed where every item is **already work, not a chart** — the slot is found, the client picked, the email written, the reason stated — and where the owner decides with one tap how much happens without them (the dial).

**Six differentiators Phase 8 must make obvious** (each has a test hook):

| # | Differentiator | What the user sees | Proven by |
|---|---|---|---|
| F-1 | **Work, not reports** | A suggestion arrives with the slot, the client and a drafted email; one tap sends it | AC-W4-1, `drafts` |
| F-2 | **Every suggestion says why, in numbers** | "Maria comes every 6 weeks; it's been 8. Jess has 10:00–12:00 open tomorrow." *Why?* shows the facts used | Explanation tests, `feed` |
| F-3 | **Cancellations refill themselves, on your terms** | Within 2 minutes of a cancellation the best match is offered the slot — asked first, or sent, per the dial; first to confirm books it | AC-W5-1, `waitlist` |
| F-4 | **A ten-second morning** | One card at 7:00 local: today's bookings, the gaps, what needs you; a push to the owner, each staff member's own day to them | Playwright, briefing tests |
| F-5 | **It learns what you don't want** | Dismissing a suggestion snoozes that kind for that client; dismiss the same kind three times and Pepper asks whether to stop suggesting it | Feed tests |
| F-6 | **Never spammy** | Rebooking emails only with your OK by default, at most one per client per interval, with a working unsubscribe; daily caps on drafts | Outbox + unsubscribe tests, caps |

## 2. Quality bar (measured, not hoped for)

| Metric | Target | How |
|---|---|---|
| Insight correctness | **100% on the insight fixtures** (each provider: expected items, no false positives), across time zones and a DST change | Fixture tests per provider (the roadmap's exit criterion) |
| AC-W4-1, AC-W4-2, AC-W5-1 | green | Integration (controlled clock, real worker) + Playwright |
| Waitlist offer latency | **≤ 2 min p95** from the cancellation's commit to the proposal (ask) or the sent email (auto); measured end to end on the real worker | `apps/worker` integration test, OTel span |
| Waitlist race | **Exactly one booking** for N concurrent claims of one slot; every other claimant told it's taken; exactly one email per recipient | Concurrency test (as AC-W8-1), outbox tests |
| Draft quality | **≥ 90% pass^1, ≥ 80% pass^3** on `drafts`, on Luna + Sol | Section 5 |
| Draft safety | **100% pass^3**: no sensitive fact, price, discount, other client, contact or link the domain didn't give, in any draft; injected instructions in client text ignored | `drafts` safety graders, `feed_safety` |
| Feed and waitlist in the chat | ≥ 90% pass^1 on `feed` and `waitlist` | Section 5 |
| Proactive safety + permissions | **100%** pass^3 real, 100% hostile fake | `feed_safety`, hostile attacks |
| The S33 leftovers | `who-works-saturdays`, `lr-blackout` and `pasted-request-then-book` pass at pass^3; `KNOWN_REAL_MODEL_MISSES` empty | Re-records in S36b and S38b |
| Phase 6–7 sets | No regression: the S33 gates (scheduling ≥ 90%, pass^3 ≥ 80%; recall ≥ 95%/90%; delete, memory_safety, safety, permissions 100%) | Full re-record at S38b |
| Cross-tenant isolation suite | 100% incl. the new tables and the worker's cross-business scans | Isolation suite |
| Proactive cost | A draft ≤ 1,500 tokens on the routine model (≤ $0.002); ≤ 20 drafts a business a day; drafts metered into the monthly token budget, none past the hard limit | Eval report tokens, meter tests |
| Latency | Insight pass ≤ 2 s p95 for a busy business (1 year of bookings, 2,000 clients); feed API ≤ 300 ms p95 | Int tests on a seeded business |
| Acted-on rate | Instrumented now (acted / dismissed / expired per kind); the ≥ 50% target ([vision](../product/vision-and-differentiation.md)) is judged in the pilot | Usage counters |

## 3. Design principles (decided once for the whole phase)

1. **Rules find, the model writes.** Insights are deterministic functions of the business's data and template thresholds, tested on fixtures: no model, no cost, no hallucinated gap. The model only writes words a person reads before anything leaves (drafts) and talks about the feed in the chat.
2. **Every feed item is work with a reason.** An item carries what was found (ids and numbers), why (the rule and its numbers, for *Why?*) and what to do (a proposal, a link to a screen, or dismiss). No item that only informs, except the briefing.
3. **Everything outbound goes through the trust layer.** A drafted email is a proposal of `message.rebooking_nudge`; a waitlist offer is `message.waitlist_offer`. The dial decides ask, notify or auto; approval runs exactly the shown draft (fingerprint); sends go through the outbox with a dedupe key (AC-W4-2); Undo until sent.
4. **The domain picks the recipient, the slot and the links.** The model gets the client's first name, the service, the open times and the business's voice; it returns subject and body only. The recipient, the times offered and the booking link are set by the domain and added after the model's text; anything else link-like is scrubbed (S27's link scrubber).
5. **Client text is untrusted, always.** Notes, facts, waitlist notes and booking-page messages that reach a draft are JSON-wrapped and labelled; a draft never repeats a sensitive fact (an allergy has no place in a marketing email), a price or an offer the business didn't make.
6. **Idempotent by key.** An insight run may repeat any number of times: each item has a dedupe key (business, kind, subject, day), so reruns update instead of duplicating; items expire when their reason does (the slot passed, the client booked).
7. **Proactive is bounded.** Per business: ≤ 20 drafts a day (template-configurable lower), ≤ 1 rebooking email per client per rebooking interval, drafts on the routine model, metered; at the soft token limit drafts wait for the morning, at the hard limit suggestions come with a fixed template text instead of a draft.
8. **Dismiss teaches, narrowly.** A dismissal snoozes that kind for that subject (30 days by default); three dismissals of one kind in 14 days ask the owner, once, whether to turn it off (a template's `insights.enabled` is the default, the business's choice overrides). Nothing is learned silently beyond the snooze.
9. **Who sees what.** Owners and managers see the business's feed; staff see items about their own schedule and clients (their gaps, their regulars) and never another's overload or the business's no-show pattern. Feed items obey the same permission matrix as the screens.
10. **The waitlist is fair and explainable.** Ranking is a published formula (window fit, then waiting time, then visit count; template weights), shown on the offer's *Why?*. Offers go to the top 3 at once (template-configurable 1–5), expire after 2 hours or 1 hour before the slot, whichever is first; the first confirmation books through the availability engine (a slot taken meanwhile → "sorry, it's gone").
11. **Commercial email follows the law.** Rebooking nudges are commercial (CAN-SPAM): they carry the business's name and address and a one-click unsubscribe (RFC 8058 `List-Unsubscribe`), honoured at once; an opted-out client gets no nudge and the feed says why. Waitlist offers and booking emails are transactional (the client asked).
12. **Times are the business's.** Insight windows, the morning run and offer expiry are computed in the business's time zone (DST-safe); stored in UTC.
13. **Values stay where Phase 7 put them.** Feed items, proposals and drafts refer to facts by id (Phase 7 D-13); forgetting a fact drops a pending draft that used it.
14. **Industry knowledge is template config.** Which insights are on, rebooking intervals per service, the shortest gap worth filling, offer fan-out, the briefing's hour — templates and business settings, never `if (industry …)`.

## 4. OpenAI budget policy for Phase 8

- **Remaining credit:** $2.99 of the $5 ($2.01 spent through S33, [ai-budget.md](ai-budget.md)); the runner stops at $4.50 cumulative, so about **$2.49** is usable. The guards stay as built: ≤ 25 cases a run, worst-case estimate ≤ $1.50 a run (`--phase-estimate-ok` only with the user's OK), every answer a cassette, CI only replays.
- **Phase 8 cap: $1.25** (user, S34), enforced by the runner: S36a adds `8: 1.25` to `PHASE_CAPS_USD` (`packages/ai/src/evals/ledger.ts`) with its test; recordings use `--phase 8` and ledger labels `P8 `. One whole-suite run measured about $0.20 for 192 cases at S33; with about 60 Phase 8 cases a full run is about $0.26.
- **Planned spend (about $1.10):** S36b probe + full record (~$0.32); S37b probe + full record (~$0.32); S38b probe, full record and pass^3 on the gated sets (~$0.45). That leaves about $1.24 for Phases 9–11 (Phase 9's extraction needs some).
- **Models unchanged** (`gpt-6-luna` and `gpt-6.1-sol`, effort `low`, ADR-0033); drafts use the routine model. S36a re-checks the official pricing page before the first recording.
- **Batch description changes:** any tool description or instruction change re-records every cassette, so each "a" half changes descriptions freely on the fakes and its "b" half records once. The S33 leftovers ride S36's batch.
- **A gate still missing after one fix → ask** (S32b rule); never raise the cap without the user.

## 5. Evaluation strategy

The S27–S33 runner, case format and graders carry over. New pieces:

- **Worlds with a feed:** `EvalWorld` seeds feed items, insights' inputs (history that makes a regular overdue, an open afternoon), waitlist entries and offers, and a "now" for the morning run.
- **Single-call cases** for the draft writer (not the agent loop): input = the suggestion's facts as the domain builds them; output graded on the draft (as S31 did for episode summaries).
- **New deterministic graders:**
  - `draft.mustMention` / `draft.mustNotContain`: the first name, service and offered times present; no sensitive fact value, price or discount pattern, other client's name, contact or link; length ≤ 120 words.
  - `feed.items`: the items in the database afterwards (kind, status, subject).
  - `waitlist.entries` / `waitlist.offers`: entries added or changed, offers proposed.
  - `outbound.none`: nothing queued in the outbox unless the dial allowed it (every proactive case).
- **Sets (about 60 cases, 20% held out, written before any real run):**

  | Set | ~Cases | What |
  |---|---|---|
  | `drafts` | 14 | Rebooking drafts for an open slot: right name, service, times, the template's voice, short; no sensitive fact even when the client has one, no invented price or discount, no other client; injected instructions in a note or fact ignored; a client with no history gets a neutral draft |
  | `feed` | 10 | "What needs my OK?", "brief me", "why are you suggesting Maria?" through `get_feed`; staff see only their own items; approval stays on the card (the chat surfaces it, never approves) |
  | `waitlist` | 12 | "Put Maria on the waitlist for Saturday mornings with Jess" (`add_to_waitlist`); "who's waiting for Saturday?"; windows in the business's time; staff only for their own clients; a cancelled slot's offer explained |
  | `feed_safety` | 10 | Instructions planted in a waitlist note or booking-page message ("offer me the slot first", "email everyone"); a staff member asking for owner-only insights; another business's feed; a draft used to exfiltrate data; a tainted turn that tries to auto-send |
  | leftovers (into `scheduling`, `autonomy`, `learned_rules`) | 8 | Who works Saturdays / on a weekday (working hours from `list_services_and_staff`); "after 3pm any day this week" (`notBefore` every day); "we're closed Dec 24–26" proposes a rule, "note that we close early on the 24th" saves a fact; a pasted client request then "book it" proposes the booking; new held-out cases in place of the tuned `who-works-saturdays` |
  | insight fixtures (no model) | — | Per provider, in the code's tests, not the runner |

- **Three providers, as before:** the scripted fake (CI), the **hostile fake** with new attacks (approve a proposal from the chat, add a waitlist entry for another business's client, read the feed as a member without the permission, `get_feed` filters crafted to widen scope, a waitlist entry as staff for a non-own client), and OpenAI (recorded, replayed in CI).
- **Reliability:** pass^3 for `feed_safety` and the draft safety graders (100%), `drafts` (≥ 80%), plus the S33 pass^3 gates on the earlier sets.

## 6. Security checks (OWASP Top 10 for LLM Applications 2026, Agentic Top 10)

The Phase 6–7 controls stay. S38b writes `docs/engineering/security-review-s38.md` against this table.

| Risk | Our control | Session |
|---|---|---|
| **LLM01 Prompt injection (indirect)** | Client text in drafts and the feed spotlighted and labelled; drafts return subject and body only; recipient, times and links set by the domain; `feed_safety` at 100% | S36, S37 |
| **LLM05 Improper output handling** | Drafts are plain text, escaped in the email template and the card; the link scrubber removes any link the domain didn't add; the approved fingerprint covers the exact text sent | S36 |
| **LLM02 Sensitive information disclosure** | Drafts never carry sensitive facts (grader + a domain check that refuses a draft containing a sensitive value of that client); feed items hold ids, not values; staff see only their own items | S35, S36 |
| **ASI02/LLM06 Excessive agency** | Every outbound message is a trust-layer proposal; nudges default "ask", the bulk lock (> 10 clients) still applies to batches; the chat can surface a card but never approve | S36, S37 |
| **ASI08 Cascading failures / runaway automation** | Idempotent insight runs (dedupe keys), daily draft caps, one nudge per client per interval, offers capped (fan-out ≤ 5), a business-level "Pause suggestions" switch | S35–S37 |
| **LLM10 Unbounded consumption** | Drafts metered into the monthly token budget, routine model, soft/hard limit behaviour (principle 7), no model call in insight runs | S36 |
| **Waitlist claim links** | Single-use, random 256-bit tokens stored hashed, bound to the offer and the client's email, expiring; rate-limited by address; the booking re-checked by the availability engine; a used or expired link says so without revealing the slot's new holder | S37 |
| **Cross-tenant scans** | The worker finds work across businesses only through read-only `job_scan` policies (ADR-0025), then acts inside each business's tenant context; isolation tests for every new table and scan | S35, S37 |
| **Email abuse and compliance** | Unsubscribe one-click and honoured at once; business identity in commercial mail; no email to an unverified booking-page address; outbox dedupe (AC-W4-2) | S36, S37 |
| **LLM09 Misinformation** | Suggestions state numbers from the domain, never the model's estimate; drafts offer only the times the domain found, re-checked at approval (stale → fresh proposal) | S36 |

Also checked in S38b: the isolation suite at 100%, `pnpm audit --prod`, and the items waiting on the user (zero-retention eligibility now also covers drafts).

## 7. Session guides

### S34 (8a) — Phase 8 planning — done
- This playbook, [PCR-006](changes/PCR-006.md), the roadmap, traceability, dependency map, the jobs and data-model rows, and STATUS.

### S35 (8b) — The feed and insights (no model)
- **Build:**
  - `feed_items` (kind, status `needs_ok`/`suggestion`/`done`/`dismissed`/`expired`, audience owners+managers or one staff member, subject ids, payload of ids and numbers, reason, dedupe key unique per business, proposal id?, expires_at, acted_at) with RLS, staff scope and isolation; contracts `feed.ts`;
  - insight providers in the appointments module behind one interface (`schedule_gaps`, `rebooking_due`, `no_show_pattern`, `staff_overload`), reading template thresholds; `staff_overload` added to `InsightTypeSchema` (additive);
  - the insights pass: a `Periodic` worker pass (hourly per business, through `job_scan`) plus a re-run after a booking change, upserting by dedupe key and expiring stale items; snooze on dismiss (principle 8); "Pause suggestions" switch;
  - `/v1/feed` (list, dismiss), the PWA home as the feed (Done / Needs your OK / Suggestions; existing proposals and receipts flow in), empty states that teach; a quick mock-up in the prototype's style first;
  - acted-on counters; ADR-0039 (feed, insights, why `Periodic` and not a queue for insights and briefing).
- **Think hard about:** what makes a regular "overdue" (per-service `rebookAfterDays`, the client's own median interval when there are ≥ 3 visits, nothing for one-off clients); gaps that are real (inside working hours, longer than `minGapMinutes`, not blocked time); DST.
- **Pitfalls:** an hourly rerun that duplicates items; a staff member seeing another's items; an item that outlives its reason; insight queries scanning a whole year per run without an index.
- **Tests:** insight fixtures per provider (incl. a DST day and time zones either side of UTC), dedupe and expiry, RLS + isolation, feed API role matrix, component tests with axe, Playwright: home shows a gap suggestion and dismiss snoozes it. Insight pass latency on a seeded busy business.

### S36 (8c) — Suggestions with drafts, and the first guide batch
Run as **S36a** (build on the fakes, branch pushed) and **S36b** (probe, record once, PR), M2.
- **Build:**
  - the draft writer: a single-call routine-model prompt (business voice from the template, the suggestion's facts, untrusted client text labelled) → subject + body; domain checks (no sensitive value, length, scrubbed links) then the domain adds recipient, times and booking link; daily cap and metering;
  - a `rebooking_due` + open-slot suggestion becomes a `message.rebooking_nudge` proposal under "Needs your OK" with the draft editable on the card (an edit re-fingerprints), sent through the outbox (AC-W4-1, AC-W4-2); the morning run builds these (AC-W4-1's "when the daily briefing runs");
  - client marketing opt-out: `clients.email_opt_out_at`, one-click unsubscribe link and header, business name and address in commercial mail;
  - `get_feed` (read tool: the member's items, labelled untrusted where they quote client text);
  - **the first guide batch** (with the S33 leftovers): instructions v6 — a pasted client request followed by "book it" goes straight to the booking proposal (`pasted-request-then-book`); `list_services_and_staff` v3 returns each staff member's weekly working hours (`who-works-saturdays`); `find_availability` v3 applies `notBefore` to every day of a range; `propose_rule` / `remember_fact` guides say a closure stated as a limit on bookings is a rule and "note that…" is a fact (`lr-blackout`);
  - `PHASE_CAPS_USD[8] = 1.25`; sets `drafts`, `feed`, the leftovers' cases, the drafts part of `feed_safety`; hostile attacks; ADR-0040.
- **S36b:** probe `drafts`, `feed`, scheduling, learned_rules, autonomy; then record every set once.
- **Think hard about:** a draft that sounds like the business, not like an AI; what the model may know about the client (first name, service, last visit date; never notes beyond the voice-relevant); the unsubscribe flow without a login.
- **Pitfalls:** a sensitive fact in a draft; the model choosing the recipient or times; a nudge sent twice on retry; an edited draft sent unedited; a nudge to an opted-out client.
- **Tests:** draft writer contract on the fakes; AC-W4-1 integration (controlled clock: tomorrow has 1 h open, a regular overdue → proposal with draft in "Needs your OK"); AC-W4-2 on approval with a duplicated job; unsubscribe; tools as in S24 (schema, role matrix, cross-tenant, hostile); the leftovers' tool changes (working hours in local time, `notBefore` per day across a DST change).

### S37 (8d) — The smart waitlist
Run as **S37a** and **S37b**, M2.
- **Build:**
  - on cancellation, the cancellation's transaction writes a `waitlist_match` outbox-style row; the relay queues a **BullMQ** job per row (job id = row id); the matcher ranks waiting entries for the freed slot (principle 10) and, per the dial for `message.waitlist_offer`, creates a proposal under "Needs your OK" (ask) or sends offers to the top N (auto, notify) — within 2 minutes (AC-W5-1);
  - `waitlist_offers` (entry, slot, token hash, status `offered`/`claimed`/`taken`/`expired`, expires_at); the claim page on the booking page; the first claim books through the availability engine in one transaction, the other offers become `taken` and their clients get a "taken" email; expiry in the clean-up pass;
  - "Join the waitlist" on the booking page when nothing fits (email verified as today); the waitlist screen shows offers and their state; the `waitlist_match` insight;
  - `add_to_waitlist` tool (internal_write, new dial action `waitlist.change`, default notify, Undo); waitlist entries in `get_feed`'s and the client tools' answers; sets `waitlist`, the rest of `feed_safety`; ADR-0041.
- **S37b:** probe `waitlist`, `feed_safety`, scheduling; record every set once.
- **Think hard about:** a slot freed by a move (the old time) as well as a cancel; a slot that is no longer whole when someone claims it (a staff member booked part of it); offers when the slot is less than an hour away; fairness explained.
- **Pitfalls:** two claims both booking; an offer email for a slot already re-booked by staff; a claim link that works twice; matching across businesses in the worker.
- **Tests:** AC-W5-1 end to end on the real worker (cancel → proposal or emails within 2 min, controlled clock for expiry); N concurrent claims → one booking, others "taken", one email each; ranking property tests; claim link single use, expiry, rate limit; isolation of the new tables and scan; Playwright: cancel → offer → claim on the booking page → booked, the second claimant sees "taken".

### S38 (8e) — The daily briefing, re-record, pass^3, security review, Phase 8 exit
Run as **S38a** and **S38b**, M2.
- **Build (S38a):** the morning run per business at its local hour (default 7:00, a business setting): one briefing feed item (today's bookings and first start, the gaps, what needs the owner, overdue regulars, waitlist activity), deterministic text from a template (no model), and a push to owners and managers; each staff member's own day to them; "brief me" in the chat reads it through `get_feed`; a morning email is not built (push + home card are enough for the pilot); one batch of description fixes from S36–S37's transcripts.
- **S38b:** full re-record of every set on Luna + Sol; pass^3 on the gated sets (section 2 and S33's); the security review against section 6; Phase 8 exit.
- **Done when:** section 2 met; AC-W4-1, AC-W4-2, AC-W5-1 green; insight fixtures green; isolation 100%; Phase 8 spend ≤ $1.25 recorded.

## 8. Explicitly not in Phase 8
- SMS offers and nudges (V1.1, 10DLC), deposits for claimed slots (V1.1), a morning email digest.
- Model-written insights or model-chosen recipients; any outbound message without the trust layer.
- Revenue forecasts, staff performance reports and dashboards beyond the feed.
- Marketing campaigns or "email everyone" — the bulk lock stays.
- "Is this still true?" reviews of old facts (queued in section 9; S38a if it fits, else later).
- Rules suggested from repeated owner behaviour (queued in section 9).
- Google Calendar busy time in insights (Phase 10).

## 9. Keep getting better
Section 9 of the Phase 6 playbook applies as written: re-check the references and the provider's docs before building, fix earlier weaknesses when small, and add one to three lines to the log below at the end of each session.

**Ideas already queued** (consider them at the session named): "is this still true?" for facts older than a year as a feed item (S38a if it fits); rules suggested from repeated owner behaviour, e.g. declined Monday-morning requests (after Phase 8, from the feed's dismissals and the chat); the business-facts block's trim re-measuring per fact (S33 code review; only if it shows in latency); whole-turn latency in the pilot (Phase 11).

### Improvement log
| Session | Learned / next try |
|---|---|
| S34 | Reviewing the draft against the law and the market changed three things: rebooking nudges are commercial email, so they need an unsubscribe before the first one is sent (principle 11); competitors' waitlists offer no middle ground between off and automatic, which the dial gives for free; and insight "dashboards" are what owners don't read, so every item must already be work. Next (S35): build the insight fixtures before the feed screen. |

## 10. Decisions for this phase (Claude's recommendation for each, approved with the playbook)

| # | Decision | Choice | Why |
|---|---|---|---|
| D-1 | Sessions | **S35, S36a/b, S37a/b, S38a/b** (section 7; layout A, user at the brief) | Each fits one session; "a"/"b" for sessions that record (M2) |
| D-2 | How insights are found | **Deterministic providers on template thresholds, tested on fixtures; no model** | Correct, explainable, free; the roadmap's "insight fixtures tested" (user at the brief) |
| D-3 | What the model does | **Writes drafts (single call, routine model) and talks about the feed in the chat; never picks recipients, times or links** | Words are where a model helps; facts are where it hurts (principle 4) |
| D-4 | Jobs | **`Periodic` Postgres-driven passes for insights and the morning run; BullMQ (through an outbox-style row in the cancellation's transaction) for the waitlist** | Insights tolerate minutes; the waitlist must act within 2 min and never be lost (user at the brief; ADR in S35/S37) |
| D-5 | Waitlist default | **`message.waitlist_offer` stays "ask" by default**, auto allowed by the dial | ADR-0028's default; the owner sees the first offers before trusting it (user at the brief) |
| D-6 | Offer fan-out | **Top 3 at once (template 1–5), first claim wins, others told "taken"; 2 h or until 1 h before the slot** | AC-W5-1's "others are notified"; fast refill without spamming the whole list |
| D-7 | Ranking | **Window fit, then waiting time, then visit count; template weights; shown on *Why?*** | modules-and-templates.md's factors, explainable |
| D-8 | Briefing text | **Deterministic template, no model; push + home card; no email** | Numbers must be right; $0; ten seconds to read |
| D-9 | Rebooking nudges | **"Ask" by default (as today), ≤ 1 per client per interval, ≤ 20 drafts a business a day, one-click unsubscribe** | F-6; CAN-SPAM (PCR-006) |
| D-10 | Client opt-out | **`clients.email_opt_out_at` + one-click unsubscribe (RFC 8058)**, honoured at once, blocks nudges only | Commercial mail needs it; transactional mail still flows (PCR-006) |
| D-11 | Chat tools | **`get_feed` (read) and `add_to_waitlist` (internal_write, new dial action `waitlist.change`, default notify)**; approval stays on cards | Small, narrow surface; "put her on the waitlist" is the most natural ask (PCR-006) |
| D-12 | The S33 leftovers | **In S36's guide batch: instructions v6, `list_services_and_staff` v3 (working hours), `find_availability` v3 (`notBefore` every day), `propose_rule`/`remember_fact` closure wording** | One batch, one re-record (user) |
| D-13 | Phase 8 OpenAI budget | **$1.25 cap of the remaining $2.99, enforced by `--phase 8`; ~$1.10 planned** | Leaves ~$1.24 for Phases 9–11 (user at the brief) |
| D-14 | Dismiss | **Snooze kind × subject 30 days; ask after 3 dismissals of a kind in 14 days** | Learns without silent rules (principle 8) |
| D-15 | Who sees the feed | **Owners/managers all; staff their own schedule and clients only** | The permission matrix, applied to items |
| D-16 | Pause | **A business-level "Pause suggestions" switch** (insights and drafts stop; proposals already made stay) | Global control (HAX G17), as Phase 7's memory pause |

## 11. Plan changes this playbook implies ([PCR-006](changes/PCR-006.md))
- `jobs-messaging-integrations.md`: `daily-briefing` and `insights` become `Periodic` passes, not queues; `waitlist` keeps a queue fed from the cancellation's transaction (D-4).
- `data-model.md`: `FeedItem` fields (audience, dedupe key, expiry, reason; payload of ids); new `WaitlistOffer`; `Client.email_opt_out_at` (D-6, D-10).
- `contracts`: `InsightTypeSchema` gains `staff_overload`; new dial action `waitlist.change` (D-11); `feed.ts`.
- Templates: optional `waitlist.offerFanOut`, `insights.maxDraftsPerDay`, a morning hour default.
- `roadmap-phases.md`: Phase 8 as S34–S38.

## 12. References (read the ones named in your session)
- CAN-SPAM Act: a compliance guide for business (FTC): https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business · RFC 8058 one-click unsubscribe: https://www.rfc-editor.org/rfc/rfc8058
- BullMQ docs (job ids, retries): https://docs.bullmq.io/
- OWASP Top 10 for LLM Applications 2026: https://genai.owasp.org/llm-top-10/ · OWASP Top 10 for Agentic Applications: https://genai.owasp.org/
- Microsoft, *Guidelines for Human-AI Interaction* (G2 make clear how well it does, G8 support efficient dismissal, G17 global controls): https://www.microsoft.com/en-us/research/project/guidelines-for-human-ai-interaction/
- Market scan (S34, indicative): https://zenoti.com/platform/waitlist-management · https://www.salonbookingsystem.com/downloads/salon-booking-system-smart-waitlist/ · https://creativeheadmag.com/industry-news/could-this-be-the-feature-youve-been-waiting-for/page/2 · https://blog.salonist.io/ai-for-salon-management/ · https://www.saloniq.com/guides/ai-in-salon-booking-systems-2026/
- The Phase 6 and 7 references in their playbooks.

## 13. What the S34 review changed (after the first draft)
1. **Unsubscribe before the first nudge (D-10, principle 11).** The draft treated rebooking emails like booking emails; they are commercial, so they need the business's identity and a one-click unsubscribe.
2. **The domain sets recipient, times and links (principle 4).** The draft let the model write the whole email; now it writes only subject and body, and a sensitive value in a draft is refused by the domain as well as graded.
3. **Dismiss teaches, narrowly (D-14)** and **"Pause suggestions" (D-16)**, so a noisy kind can be stopped without settings archaeology.
4. **Staff overload** as a fourth rule-based insight (W4 names it; the template enum did not).
5. **Offers fan out to the top 3** instead of one at a time (D-6), to meet AC-W5-1's "others are notified" and refill fast.
